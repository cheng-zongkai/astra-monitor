import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    CpuHardwareReader,
    gpuSummarySensors,
    millidegrees,
    readAmdSysfs,
    sysfsNumber,
    wattsFromEnergy,
} from '../build/src/utils/hardwareReadings.js';

function fixture(initial = {}) {
    const files = new Map(Object.entries(initial));
    return {
        files,
        read: async path => files.get(path) ?? '',
        list: async path => [
            ...new Set(
                [...files.keys()]
                    .filter(key => key.startsWith(path + '/'))
                    .map(key => key.slice(path.length + 1).split('/')[0])
            ),
        ],
    };
}
function hwmon(io, id, name, sensors) {
    const base = `/sys/class/hwmon/hwmon${id}`;
    io.files.set(`${base}/name`, name);
    for(const [index, [label, value]] of sensors.entries()) {
        io.files.set(`${base}/temp${index + 1}_label`, label);
        io.files.set(`${base}/temp${index + 1}_input`, String(value));
    }
    return base;
}
function rapl(io, id, name, energy) {
    const base = `/sys/class/powercap/intel-rapl:${id}`;
    io.files.set(`${base}/name`, name);
    io.files.set(`${base}/energy_uj`, String(energy));
    io.files.set(`${base}/max_energy_range_uj`, '1000000000');
    return base;
}

test('strict parsing preserves real zero and rejects empty, corrupt and sentinel readings', () => {
    for(const value of ['', ' ', 'NaN', 'Infinity', '123abc', '0x10'])
        assert.equal(sysfsNumber(value), undefined);
    assert.equal(sysfsNumber('0\n'), 0);
    assert.equal(millidegrees('44375'), 44.375);
    assert.equal(millidegrees('-273150'), undefined);
    assert.equal(millidegrees('65535000'), undefined);
});

test('Ryzen uses Tdie before offset Tctl, CCD, GPU and motherboard temperatures', async () => {
    const io = fixture();
    hwmon(io, 0, 'amdgpu', [['edge', 90000]]);
    hwmon(io, 1, 'nct6687', [['CPU', 80000]]);
    hwmon(io, 2, 'k10temp', [
        ['Tctl', 70000],
        ['Tdie', 50000],
        ['Tccd1', 60000],
    ]);
    assert.deepEqual((await new CpuHardwareReader(io, () => 0).read()).temperature, {
        value: 50,
        source: 'k10temp / Tdie',
    });
});

test('Ryzen 5600 uses Tctl when Tdie is not exposed and refreshes live readings', async () => {
    const io = fixture();
    const base = hwmon(io, 2, 'k10temp', [
        ['Tctl', 44000],
        ['Tccd1', 48500],
    ]);
    const reader = new CpuHardwareReader(io, () => 0);
    assert.equal((await reader.read()).temperature.value, 44);
    io.files.set(`${base}/temp1_input`, '45125');
    assert.equal((await reader.read()).temperature.value, 45.125);
});

test('Intel selects hottest package without mixing per-core or unrelated sensors', async () => {
    const io = fixture();
    hwmon(io, 0, 'coretemp', [
        ['Package id 0', 48000],
        ['Core 0', 60000],
    ]);
    hwmon(io, 1, 'coretemp', [
        ['Package id 1', 52000],
        ['Core 6', 65000],
    ]);
    assert.equal((await new CpuHardwareReader(io, () => 0).read()).temperature.value, 52);
});

test('faulted, disabled and removed CPU sensors do not leave stale values', async () => {
    const io = fixture();
    const base = hwmon(io, 0, 'coretemp', [
        ['Package id 0', 48000],
        ['Core 0', 45000],
    ]);
    const reader = new CpuHardwareReader(io, () => 0);
    io.files.set(`${base}/temp1_fault`, '1');
    assert.equal((await reader.read()).temperature.value, 45);
    io.files.set(`${base}/temp2_enable`, '0');
    assert.equal((await reader.read()).temperature, null);
    io.files.clear();
    assert.equal((await reader.read()).temperature, null);
});

test('fallback uses CPU thermal zones and ignores generic ACPI and GPU zones', async () => {
    const io = fixture({
        '/sys/class/thermal/thermal_zone0/type': 'acpitz',
        '/sys/class/thermal/thermal_zone0/temp': '95000',
        '/sys/class/thermal/thermal_zone1/type': 'cpu-thermal',
        '/sys/class/thermal/thermal_zone1/temp': '42000',
    });
    assert.deepEqual((await new CpuHardwareReader(io, () => 0).read()).temperature, {
        value: 42,
        source: 'cpu-thermal',
    });
});

test('power computes watts from consecutive samples and sums packages, not subdomains', async () => {
    const io = fixture();
    const a = rapl(io, '0', 'package-0', 100000000);
    const b = rapl(io, '1', 'package-1', 200000000);
    rapl(io, '0:0', 'core', 999);
    let now = 0;
    const reader = new CpuHardwareReader(io, () => now);
    assert.equal((await reader.read()).power, null);
    now = 2;
    io.files.set(`${a}/energy_uj`, '140000000');
    io.files.set(`${b}/energy_uj`, '260000000');
    assert.equal((await reader.read()).power, 50);
    reader.reset();
    assert.equal((await reader.read()).power, null);
});

test('unreadable RAPL does not produce zero watts or a partial package total', async () => {
    const io = fixture();
    rapl(io, '0', 'package-0', 100000000);
    const b = rapl(io, '1', 'package-1', 100000000);
    let now = 0;
    const reader = new CpuHardwareReader(io, () => now);
    await reader.read();
    now = 1;
    io.files.delete(`${b}/energy_uj`);
    assert.equal((await reader.read()).power, null);
});

test('energy wrap, reset, zero elapsed time and suspend gaps are handled', () => {
    assert.equal(wattsFromEnergy(950000000, 50000000, 2, 1000000000), 50);
    assert.equal(wattsFromEnergy(100000000, 10000000, 1, 1000000000), undefined);
    assert.equal(wattsFromEnergy(1, 2, 0), undefined);
    assert.equal(wattsFromEnergy(1, 2, 120), undefined);
    assert.equal(wattsFromEnergy(100000000, 100000000, 1), 0);
});

function amd(io, pci, busy = '12', temp = '64000', power = '23000000') {
    const base = `/sys/bus/pci/devices/${pci}`;
    io.files.set(`${base}/gpu_busy_percent`, busy);
    io.files.set(`${base}/mem_info_vram_used`, '2147483648');
    io.files.set(`${base}/mem_info_vram_total`, '8589934592');
    const hw = `${base}/hwmon/hwmon4`;
    io.files.set(`${hw}/name`, 'amdgpu');
    io.files.set(`${hw}/temp1_input`, temp);
    io.files.set(`${hw}/temp1_label`, 'edge');
    io.files.set(`${hw}/temp2_input`, '75000');
    io.files.set(`${hw}/temp2_label`, 'junction');
    io.files.set(`${hw}/power1_average`, power);
    io.files.set(`${hw}/power1_cap`, '127000000');
    return hw;
}

test('AMD sysfs reads percent, bytes, Celsius and watts from the correct PCI device', async () => {
    const io = fixture();
    amd(io, '0000:2d:00.0');
    amd(io, '0000:03:00.0', '99', '90000', '250000000');
    const result = await readAmdSysfs(io, '0000:2d:00.0');
    assert.equal(result.activity, 12);
    assert.equal(result.vramUsed, 2147483648);
    assert.equal(result.vramTotal, 8589934592);
    assert.deepEqual(
        gpuSummarySensors(result.sensors).map(sensor => sensor.value),
        [64, 23]
    );
});

test('GPU zero load/power are valid, missing readings stay unavailable', async () => {
    const io = fixture();
    const path = amd(io, '0000:2d:00.0', '0', '64000', '0');
    let result = await readAmdSysfs(io, '0000:2d:00.0');
    assert.equal(result.activity, 0);
    assert.equal(gpuSummarySensors(result.sensors)[1].value, 0);
    io.files.delete(`${path}/power1_average`);
    io.files.set(`${path}/power1_input`, '17500000');
    assert.equal(
        gpuSummarySensors((await readAmdSysfs(io, '0000:2d:00.0')).sensors)[1].value,
        17.5
    );
    io.files.clear();
    result = await readAmdSysfs(io, '0000:2d:00.0');
    assert.equal(result.activity, undefined);
    assert.deepEqual(result.sensors, []);
});

test('summary chooses temperature/power instead of clocks, thermal limits or power caps', () => {
    const sensor = (name, value, unit) => ({ name, value, unit });
    const temperature = sensor('GPU Temp', 65, 'C');
    const power = sensor('Power Draw', 120, 'W');
    assert.deepEqual(
        gpuSummarySensors([
            sensor('GPU Clock', 2500, 'MHz'),
            sensor('GPU Temp Max', 110, 'C'),
            sensor('Power Cap', 250, 'W'),
            sensor('GPU Temp', NaN, 'C'),
            temperature,
            power,
        ]),
        [temperature, power]
    );
    assert.deepEqual(
        gpuSummarySensors([sensor('CPU Package', 50, '°C'), sensor('Package Power', 60, 'W')]),
        [undefined, undefined]
    );
});

test('MSR and MMIO domains for the same package are not double counted', async () => {
    const io = fixture();
    const path = rapl(io, '0', 'package-0', 100000000);
    io.files.set('/sys/class/powercap/intel-rapl-mmio:0/name', 'package-0');
    io.files.set('/sys/class/powercap/intel-rapl-mmio:0/energy_uj', '100000000');
    let now = 0;
    const reader = new CpuHardwareReader(io, () => now);
    await reader.read();
    now = 1;
    io.files.set(`${path}/energy_uj`, '120000000');
    io.files.set('/sys/class/powercap/intel-rapl-mmio:0/energy_uj', '120000000');
    assert.equal((await reader.read()).power, 20);
});

test('a read finishing after menu close cannot prime the next power sample', async () => {
    const io = fixture();
    rapl(io, '0', 'package-0', 100000000);
    let now = 0;
    const reader = new CpuHardwareReader(io, () => now);
    await reader.read();
    const read = io.read;
    let release;
    let started;
    const ready = new Promise(resolve => {
        started = resolve;
    });
    io.read = async path => {
        if(path.endsWith('/energy_uj')) {
            started();
            return new Promise(resolve => {
                release = resolve;
            });
        }
        return read(path);
    };
    now = 1;
    const pending = reader.read();
    await ready;
    reader.reset();
    release('120000000');
    await pending;
    io.read = read;
    now = 2;
    assert.equal((await reader.read()).power, null);
});
