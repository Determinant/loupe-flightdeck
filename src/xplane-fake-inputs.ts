#!/usr/bin/env node

import dgram, { RemoteInfo } from "node:dgram";
import yargs from "yargs/yargs";
import { Arguments } from "yargs";

console.log("X-Plane Fake Input Server");

interface AppArgs {
    'listen-port': number;
    'listen-host': string;
}

const args = yargs(process.argv.slice(2))
    .usage("node dist/xplane-fake-inputs.js [--listen-host <host>] [--listen-port <port>]")
    .options({
        'listen-port': { default: 49000, type: 'number', describe: 'The port to listen on for X-Plane subscription requests' },
        'listen-host': { default: "0.0.0.0", type: 'string', describe: 'The host to listen on' },
    }).parse() as Arguments<AppArgs>;

const listenPort = args['listen-port'];
const listenHost = args['listen-host'];

const socket = dgram.createSocket("udp4");
const SIM_OUTPUT_HZ = 60;
const SIM_OUTPUT_INTERVAL_MS = 1000 / SIM_OUTPUT_HZ;
const REFERENCE_HZ = 20;
const HEADING_DEG_PER_SECOND = 10;
const HEADING_BUG_DEG_PER_SECOND = 2;
const COURSE_OFFSET_DEG_PER_SECOND = 1;
const BEARING_DEG_PER_SECOND = 0.6;
const DA40_NG_MAX_POWER_WATTS = 123500;

let client: RemoteInfo | null = null;
let simulationInterval: NodeJS.Timeout | null = null;
const subscribedDataRefs = new Map<number, string>();
const unknownDataRefs = new Set<string>();

const decodeDataRef = (msg: Buffer, offset: number): string => {
    const end = msg.indexOf(0, offset);
    const endIndex = end === -1 ? msg.length : end;
    return msg.toString("utf8", offset, endIndex).trim();
};

const simState = {
    time: 0,
    altitude: 10000,
    altitude_dir: 10,
    airspeed: 80,
    airspeed_dir: 1,
    bank_angle: 0,
    heading: 0,
    heading_bug: 45,
    gps_course_offset: 70,
    nav1_course_offset: 15,
    nav2_course_offset: 35,
    brg1_target: 325,
    brg2_target: 55,
    vertical_speed: 0, // In feet per minute
};

const wrapDegrees = (deg: number): number => {
    return (deg % 360 + 360) % 360;
};

const displayDegrees = (deg: number): number => {
    return Math.round(wrapDegrees(deg)) % 360;
};

const relativeDegrees = (magneticBearing: number): number => {
    return displayDegrees(magneticBearing - simState.heading);
};

const fakeEngineLoadPercent = (): number => {
    return 60 + Math.sin(simState.time * 0.35) * 35;
};

const fakeEngineRpm = (): number => {
    return 950 + fakeEngineLoadPercent() * 14;
};

const fakeManifoldPressure = (): number => {
    return 15 + fakeEngineLoadPercent() * 0.18;
};

const fakeFlapRatio = (): number => {
    return simState.airspeed < 85 ? 0.25 : 0;
};

const fakeTurnRate = (): number => {
    return Math.sin(simState.time * 0.8) * 4.5;
};

function updateSimulation(dtSeconds: number) {
    const stepScale = dtSeconds * REFERENCE_HZ;
    simState.time += dtSeconds;

    simState.altitude += simState.altitude_dir * stepScale;
    if (simState.altitude > 20000) simState.altitude_dir = -10;
    if (simState.altitude < 100) simState.altitude_dir = 10;
    simState.vertical_speed = simState.altitude_dir * 200; // Update VSI based on altitude_dir

    simState.airspeed += simState.airspeed_dir * 0.25 * stepScale;
    if (simState.airspeed > 210) simState.airspeed_dir = -1;
    if (simState.airspeed < 67) simState.airspeed_dir = 1;

    simState.bank_angle = Math.sin(simState.time / 2) * 30;
    simState.heading = wrapDegrees(simState.heading + HEADING_DEG_PER_SECOND * dtSeconds);
    simState.heading_bug = wrapDegrees(simState.heading_bug + HEADING_BUG_DEG_PER_SECOND * dtSeconds);
    simState.gps_course_offset = wrapDegrees(simState.gps_course_offset + COURSE_OFFSET_DEG_PER_SECOND * dtSeconds);
    simState.nav1_course_offset = wrapDegrees(simState.nav1_course_offset - COURSE_OFFSET_DEG_PER_SECOND * 0.7 * dtSeconds);
    simState.nav2_course_offset = wrapDegrees(simState.nav2_course_offset + COURSE_OFFSET_DEG_PER_SECOND * 0.5 * dtSeconds);
    simState.brg1_target = wrapDegrees(simState.brg1_target - BEARING_DEG_PER_SECOND * dtSeconds);
    simState.brg2_target = wrapDegrees(simState.brg2_target + BEARING_DEG_PER_SECOND * 0.8 * dtSeconds);
}

function getValueForDataRef(dataRef: string): number {
    switch (dataRef) {
        case "sim/cockpit2/gauges/indicators/altitude_ft_pilot": return simState.altitude;
        case "sim/cockpit2/gauges/indicators/airspeed_kts_pilot": return simState.airspeed;
        case "sim/cockpit2/engine/actuators/prop_ratio[0]": return 0.1;
        case "sim/cockpit2/engine/actuators/mixture_ratio[0]": return 1;
        case "sim/flightmodel/controls/flaprat": return fakeFlapRatio();
        case "sim/cockpit2/engine/indicators/power_watts[0]": return fakeEngineLoadPercent() / 100 * DA40_NG_MAX_POWER_WATTS;
        case "sim/cockpit2/engine/indicators/MPR_in_hg[0]": return fakeManifoldPressure();
        case "sim/cockpit2/engine/indicators/engine_speed_rpm[0]": return fakeEngineRpm();
        case "sim/cockpit2/engine/indicators/prop_speed_rpm[0]": return fakeEngineRpm();
        case "sim/cockpit/gyros/phi_ind_ahars_pilot_deg": return simState.bank_angle;
        case "sim/cockpit/gyros/the_ind_ahars_pilot_deg": return 2.5;
        case "sim/cockpit2/gauges/indicators/heading_AHARS_deg_mag_pilot": return displayDegrees(simState.heading);
        case "sim/cockpit2/autopilot/heading_dial_deg_mag_pilot": return displayDegrees(simState.heading_bug);
        case "sim/cockpit2/radios/actuators/HSI_source_select_pilot": return 2;
        case "sim/cockpit/radios/gps_course_degtm": return displayDegrees(simState.heading + simState.gps_course_offset);
        case "sim/cockpit/radios/gps_fromto": return 1;
        case "sim/cockpit2/radios/actuators/nav1_obs_deg_mag_pilot": return displayDegrees(simState.heading + simState.nav1_course_offset);
        case "sim/cockpit/radios/nav1_fromto": return 1;
        case "sim/cockpit2/radios/actuators/nav2_obs_deg_mag_pilot": return displayDegrees(simState.heading + simState.nav2_course_offset);
        case "sim/cockpit/radios/nav2_fromto": return 2;
        case "sim/cockpit/radios/nav1_dir_degt":
        case "sim/cockpit2/radios/indicators/nav1_relative_bearing_deg": return relativeDegrees(simState.brg1_target);
        case "sim/cockpit/radios/nav2_dir_degt":
        case "sim/cockpit2/radios/indicators/nav2_relative_bearing_deg": return relativeDegrees(simState.brg2_target);
        case "sim/cockpit2/radios/indicators/hsi_hdef_dots_pilot": return Math.sin(simState.time * 0.7) * 2;
        case "sim/cockpit2/radios/indicators/hsi_display_horizontal_pilot": return 1;
        case "sim/cockpit2/radios/indicators/hsi_vdef_dots_pilot": return Math.sin(simState.time * 0.5) * 1.5;
        case "sim/cockpit2/radios/indicators/hsi_display_vertical_pilot": return 1;
        case "sim/cockpit2/radios/indicators/hsi_flag_glideslope_pilot": return 0;
        case "sim/cockpit2/gauges/indicators/slip_deg": return -simState.bank_angle / 10;
        case "sim/flightmodel/position/R": return fakeTurnRate();
        case "sim/cockpit2/gauges/indicators/vvi_fpm_pilot": return simState.vertical_speed;
        default:
            if (!unknownDataRefs.has(dataRef)) {
                unknownDataRefs.add(dataRef);
                console.warn(`No fake value mapping for dataref: ${dataRef}`);
            }
            return 0;
    }
}

async function main() {
    socket.on('error', (err) => {
        console.error(`Socket error:\n${err.stack}`);
        socket.close();
    });

    socket.on('message', (msg, rinfo) => {
        if (msg.subarray(0, 4).toString() !== "RREF" || msg.length < 13) {
            return;
        }
        const freq = msg.readInt32LE(5);
        const idx = msg.readInt32LE(9);
        const dataRef = decodeDataRef(msg, 13);

        if (!client || client.address !== rinfo.address || client.port !== rinfo.port) {
            client = rinfo;
            console.log(`Using client ${rinfo.address}:${rinfo.port} for fake stream.`);
        }

        if (freq <= 0) {
            subscribedDataRefs.delete(idx);
            return;
        }

        subscribedDataRefs.set(idx, dataRef);
        if (!simulationInterval) {
            console.log("Received first subscription request. Starting data stream.");
            startSimulation();
        }
    });

    socket.on('listening', () => {
        const address = socket.address();
        console.log(`Fake X-Plane server listening on ${address.address}:${address.port}`);
        console.log("Run src/app.ts (or npm run start) now. Waiting for it to connect...");
    });

    socket.bind(listenPort, listenHost);
}

function startSimulation() {
    if (simulationInterval) return;
    let lastTick = Date.now();

    simulationInterval = setInterval(() => {
        if (!client) return;
        if (subscribedDataRefs.size === 0) return;
        const now = Date.now();
        const dtSeconds = Math.min((now - lastTick) / 1000, 0.25);
        lastTick = now;
        updateSimulation(dtSeconds);

        const entries = Array.from(subscribedDataRefs.entries()).sort((a, b) => a[0] - b[0]);
        const packetSize = 5 + entries.length * 8;
        const buffer = Buffer.alloc(packetSize);
        buffer.write("RREF,");
        let offset = 5;

        for (const [idx, dataRef] of entries) {
            const value = getValueForDataRef(dataRef);
            buffer.writeInt32LE(idx, offset);
            offset += 4;
            buffer.writeFloatLE(value, offset);
            offset += 4;
        }
        socket.send(buffer, 0, buffer.length, client.port, client.address);
    }, SIM_OUTPUT_INTERVAL_MS);
}

process.on("SIGINT", () => {
    console.log("\nStopping server.");
    if (simulationInterval) clearInterval(simulationInterval);
    socket.close();
    process.exit(0);
});

main().catch(err => {
    console.error("Error:", err);
    process.exit(1);
});
