/* SPDX-License-Identifier: GPL-3.0-or-later */

/** Async sysfs access, supplied by GJS in the extension and fixtures in tests. */
export type HardwareIO = {
    read: (path: string) => Promise<string>;
    list: (path: string) => Promise<string[]>;
};

type TemperatureSource = {
    path: string;
    device: string;
    label: string;
    priority: number;
};
export type CpuReadings = {
    temperature: { value: number; source: string } | null;
    power: number | null;
};

export function sysfsNumber(text: string): number | undefined {
    if(!/^-?\d+(?:\.\d+)?$/.test(text.trim())) return undefined;
    const value = Number(text.trim());
    return Number.isFinite(value) ? value : undefined;
}

export function millidegrees(text: string): number | undefined {
    const value = sysfsNumber(text);
    // Reject disconnected sensors and the -273.15 C sentinel.
    if(value === undefined || value < -40000 || value > 150000) return undefined;
    return value / 1000;
}

async function list(io: HardwareIO, path: string): Promise<string[]> {
    return io.list(path).catch(() => []);
}

async function readTemperature(io: HardwareIO, path: string): Promise<number | undefined> {
    const [input, fault, enabled] = await Promise.all([
        io.read(path),
        io.read(path.replace(/_input$/, '_fault')),
        io.read(path.replace(/_input$/, '_enable')),
    ]);
    if(fault.trim() === '1' || enabled.trim() === '0') return undefined;
    return millidegrees(input);
}

export function wattsFromEnergy(
    previous: number,
    current: number,
    elapsedSeconds: number,
    maxEnergy?: number
): number | undefined {
    if(!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0 || elapsedSeconds > 60)
        return undefined;
    if(!Number.isFinite(previous) || !Number.isFinite(current) || previous < 0 || current < 0)
        return undefined;
    let delta = current - previous;
    if(delta < 0) {
        // A wrap is only credible near the ends of a known counter range.
        if(!maxEnergy || previous < maxEnergy * 0.9 || current > maxEnergy * 0.1) return undefined;
        delta += maxEnergy;
    }
    return delta / 1000000 / elapsedSeconds;
}

export class CpuHardwareReader {
    private generation = 0;
    private sources?: TemperatureSource[];
    private packages?: string[];
    private discoveredAt = -Infinity;
    private previousEnergy = new Map<string, { value: number; time: number }>();

    constructor(
        private io: HardwareIO,
        private now: () => number
    ) {}

    reset() {
        this.generation++;
        this.previousEnergy.clear();
    }

    private async discover() {
        const base = '/sys/class/hwmon';
        const sources = await Promise.all(
            (await list(this.io, base)).map(async entry => {
                const path = `${base}/${entry}`;
                const name = (await this.io.read(`${path}/name`)).trim();
                // Do not confuse motherboard, NVMe or GPU sensors with the CPU die.
                if(!['coretemp', 'k10temp', 'k8temp', 'zenpower'].includes(name)) return [];
                return Promise.all(
                    (await list(this.io, path))
                        .filter(file => /^temp\d+_input$/.test(file))
                        .map(async file => {
                            const label = (
                                await this.io.read(`${path}/${file.replace('_input', '_label')}`)
                            ).trim();
                            let priority = 3;
                            if(label === 'Tdie' || /^Package id \d+$/.test(label)) priority = 0;
                            else if(label === 'Tctl') priority = 1;
                            else if(/^Core \d+$/.test(label) || /^Tccd\d+$/.test(label))
                                priority = 2;
                            return {
                                path: `${path}/${file}`,
                                device: path,
                                label: `${name} / ${label || file}`,
                                priority,
                            };
                        })
                );
            })
        );
        this.sources = sources.flat();

        const powercap = '/sys/class/powercap';
        const packages = await Promise.all(
            (await list(this.io, powercap)).map(async entry => {
                const path = `${powercap}/${entry}`;
                const name = (await this.io.read(`${path}/name`)).trim();
                // Sum packages only: adding their core/uncore children double-counts power.
                return /^package-\d+$/.test(name) ? { path, name } : null;
            })
        );
        const domains = packages.filter(
            (domain): domain is NonNullable<typeof domain> => domain !== null
        );
        // MSR and MMIO drivers can expose the same physical package.
        domains.sort(
            (a, b) =>
                Number(a.path.includes('rapl-mmio')) - Number(b.path.includes('rapl-mmio')) ||
                a.path.localeCompare(b.path)
        );
        const byPackage = new Map<string, string>();
        for(const domain of domains) {
            if(!byPackage.has(domain.name)) byPackage.set(domain.name, domain.path);
        }
        this.packages = [...byPackage.values()];
        this.discoveredAt = this.now();
    }

    private async temperature(): Promise<CpuReadings['temperature']> {
        const readings = await Promise.all(
            (this.sources ?? []).map(async source => ({
                ...source,
                value: await readTemperature(this.io, source.path),
            }))
        );
        const devices = new Map<string, (typeof readings)[number]>();
        for(const reading of readings) {
            if(reading.value === undefined) continue;
            const current = devices.get(reading.device);
            if(
                !current ||
                reading.priority < current.priority ||
                (reading.priority === current.priority && reading.value > current.value!)
            )
                devices.set(reading.device, reading);
        }
        const hottest = [...devices.values()].sort((a, b) => b.value! - a.value!)[0];
        if(hottest) return { value: hottest.value!, source: hottest.label };

        // Only explicitly CPU-labelled thermal zones are safe fallback sources.
        const base = '/sys/class/thermal';
        const zones = await Promise.all(
            (await list(this.io, base))
                .filter(entry => /^thermal_zone\d+$/.test(entry))
                .map(async entry => {
                    const path = `${base}/${entry}`;
                    const name = (await this.io.read(`${path}/type`)).trim();
                    if(!/^(x86_pkg_temp|cpu[-_]?thermal|cpu[-_]?temp|cpu-thermal\d*)$/i.test(name))
                        return null;
                    const value = millidegrees(await this.io.read(`${path}/temp`));
                    return value === undefined ? null : { value, source: name };
                })
        );
        return (
            zones
                .filter((zone): zone is NonNullable<typeof zone> => zone !== null)
                .sort((a, b) => b.value - a.value)[0] ?? null
        );
    }

    private async power(generation: number): Promise<number | null> {
        const readings = await Promise.all(
            (this.packages ?? []).map(async path => {
                const [energy, range] = await Promise.all([
                    this.io.read(`${path}/energy_uj`),
                    this.io.read(`${path}/max_energy_range_uj`),
                ]);
                if(generation !== this.generation) return undefined;
                const value = sysfsNumber(energy);
                if(value === undefined || value < 0) {
                    this.previousEnergy.delete(path);
                    return undefined;
                }
                const time = this.now();
                const previous = this.previousEnergy.get(path);
                this.previousEnergy.set(path, { value, time });
                return previous
                    ? wattsFromEnergy(
                          previous.value,
                          value,
                          time - previous.time,
                          sysfsNumber(range)
                      )
                    : undefined;
            })
        );
        if(!readings.length || readings.some(value => value === undefined)) return null;
        return readings.reduce<number>((sum, value) => sum + value!, 0);
    }

    async read(): Promise<CpuReadings> {
        const generation = this.generation;
        if(this.now() - this.discoveredAt > 30) await this.discover();
        const [temperature, power] = await Promise.all([
            this.temperature(),
            this.power(generation),
        ]);
        return { temperature, power };
    }
}

export type AmdSysfsReadings = {
    activity?: number;
    vramUsed?: number;
    vramTotal?: number;
    sensors: { name: string; value: number; unit: string }[];
};

/** Bind sensors to the PCI device, never a global hwmon index or a GPU model name. */
export async function readAmdSysfs(io: HardwareIO, pci: string): Promise<AmdSysfsReadings> {
    const result: AmdSysfsReadings = { sensors: [] };
    if(!/^[\da-f]{4}:[\da-f]{2}:[\da-f]{2}\.[0-7]$/i.test(pci)) return result;
    const base = `/sys/bus/pci/devices/${pci}`;
    const [busy, used, total, hwmons] = await Promise.all([
        io.read(`${base}/gpu_busy_percent`),
        io.read(`${base}/mem_info_vram_used`),
        io.read(`${base}/mem_info_vram_total`),
        list(io, `${base}/hwmon`),
    ]);
    const activity = sysfsNumber(busy);
    if(activity !== undefined && activity >= 0 && activity <= 100) result.activity = activity;
    const vramUsed = sysfsNumber(used);
    const vramTotal = sysfsNumber(total);
    if(vramUsed !== undefined && vramUsed >= 0) result.vramUsed = vramUsed;
    if(vramTotal !== undefined && vramTotal > 0) result.vramTotal = vramTotal;

    const sensors = await Promise.all(
        hwmons.map(async hwmon => {
            const path = `${base}/hwmon/${hwmon}`;
            if((await io.read(`${path}/name`)).trim() !== 'amdgpu') return [];
            const files = await list(io, path);
            const temperatures = await Promise.all(
                files
                    .filter(file => /^temp\d+_input$/.test(file))
                    .map(async file => {
                        const [value, label] = await Promise.all([
                            readTemperature(io, `${path}/${file}`),
                            io.read(`${path}/${file.replace('_input', '_label')}`),
                        ]);
                        const names: Record<string, string> = {
                            edge: 'GPU Temperature',
                            junction: 'Junction Temperature',
                            mem: 'Memory Temperature',
                        };
                        if(value === undefined) return null;
                        return {
                            name:
                                names[label.trim()] ??
                                (file === 'temp1_input' ? 'GPU Temperature' : label.trim() || file),
                            value,
                            unit: '°C',
                        };
                    })
            );
            const [average, input] = await Promise.all([
                io.read(`${path}/power1_average`),
                io.read(`${path}/power1_input`),
            ]);
            const averagePower = sysfsNumber(average);
            const power =
                averagePower !== undefined && averagePower >= 0 ? averagePower : sysfsNumber(input);
            const values = temperatures.filter(
                (sensor): sensor is NonNullable<typeof sensor> => sensor !== null
            );
            if(power !== undefined && power >= 0)
                values.push({ name: 'GPU Power', value: power / 1000000, unit: 'W' });
            return values;
        })
    );
    result.sensors = sensors.flat();
    return result;
}

type SensorValue = { name: string; value: number | string; unit: string };
/** Select actual readings, excluding power caps and temperature limits. */
export function gpuSummarySensors<T extends SensorValue>(sensors: T[]): (T | undefined)[] {
    const valid = sensors.filter(
        sensor => typeof sensor.value === 'number' && Number.isFinite(sensor.value)
    );
    const temperatureNames = [
        'GPU Temperature',
        'Edge Temperature',
        'GPU Temp',
        'Junction Temperature',
    ];
    const powerNames = ['GPU Power', 'Power Draw', 'GFX Power', 'Socket Power'];
    return [
        temperatureNames
            .map(name =>
                valid.find(
                    sensor => sensor.name === name && ['C', '°C', 'F', '°F'].includes(sensor.unit)
                )
            )
            .find(Boolean),
        powerNames
            .map(name =>
                valid.find(
                    sensor =>
                        sensor.name === name &&
                        ['W', 'mW'].includes(sensor.unit) &&
                        Number(sensor.value) >= 0
                )
            )
            .find(Boolean),
    ];
}
