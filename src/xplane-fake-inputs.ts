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
    vertical_speed: 0, // In feet per minute
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
    simState.heading = (simState.heading + HEADING_DEG_PER_SECOND * dtSeconds + 360) % 360;
}

function getValueForDataRef(dataRef: string): number {
    switch (dataRef) {
        case "sim/cockpit2/gauges/indicators/altitude_ft_pilot": return simState.altitude;
        case "sim/cockpit2/gauges/indicators/airspeed_kts_pilot": return simState.airspeed;
        case "sim/cockpit/gyros/phi_ind_ahars_pilot_deg": return simState.bank_angle;
        case "sim/cockpit/gyros/the_ind_ahars_pilot_deg": return 2.5;
        case "sim/cockpit2/gauges/indicators/heading_AHARS_deg_mag_pilot": return simState.heading;
        case "sim/cockpit2/autopilot/heading_dial_deg_mag_pilot": return (simState.heading + 45) % 360;
        case "sim/cockpit2/radios/actuators/HSI_source_select_pilot": return 2;
        case "sim/cockpit/radios/gps_course_degtm": return (simState.heading + 70) % 360;
        case "sim/cockpit/radios/gps_fromto": return 1;
        case "sim/cockpit2/radios/actuators/nav1_obs_deg_mag_pilot": return (simState.heading + 15) % 360;
        case "sim/cockpit/radios/nav1_fromto": return 1;
        case "sim/cockpit2/radios/actuators/nav2_obs_deg_mag_pilot": return (simState.heading + 35) % 360;
        case "sim/cockpit/radios/nav2_fromto": return 2;
        case "sim/cockpit2/radios/indicators/hsi_hdef_dots_pilot": return Math.sin(simState.time * 0.7) * 2;
        case "sim/cockpit2/radios/indicators/hsi_display_horizontal_pilot": return 1;
        case "sim/cockpit2/radios/indicators/hsi_vdef_dots_pilot": return Math.sin(simState.time * 0.5) * 1.5;
        case "sim/cockpit2/radios/indicators/hsi_display_vertical_pilot": return 1;
        case "sim/cockpit2/radios/indicators/hsi_flag_glideslope_pilot": return 0;
        case "sim/cockpit2/gauges/indicators/slip_deg": return -simState.bank_angle / 10;
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
