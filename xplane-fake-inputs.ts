#!/usr/bin/env node

import dgram, { RemoteInfo } from "node:dgram";
import { readFile } from "fs/promises";
import { parse } from "yaml";
import yargs from "yargs/yargs";
import { Arguments } from "yargs";

console.log("X-Plane Fake Input Server");

interface AppArgs {
    'listen-port': number;
    'listen-host': string;
    profile: string;
}

const args = yargs(process.argv.slice(2))
    .usage("./xplane-fake-inputs.ts --listen-host <host> --listen-port <port> [profile.yaml]")
    .options({
        'listen-port': { default: 49000, type: 'number', describe: 'The port to listen on for X-Plane subscription requests' },
        'listen-host': { default: "0.0.0.0", type: 'string', describe: 'The host to listen on' },
        'profile': { default: "profile.yaml", type: 'string', describe: 'Profile YAML file to read datarefs from' },
    }).parse() as Arguments<AppArgs>;

const profile_file = args.profile;
const listenPort = args['listen-port'];
const listenHost = args['listen-host'];

const socket = dgram.createSocket("udp4");

let client: RemoteInfo | null = null;
let simulationInterval: NodeJS.Timeout | null = null;

async function getSubscribedDataRefs(profilePath: string): Promise<string[]> {
    const file = await readFile(profilePath, "utf8");
    const pages = parse(file);
    const dataRefs = new Set<string>();

    for (const page of pages) {
        if (page.keys) {
            for (const key of page.keys) {
                if (key && key.display && key.display.source) {
                    for (const source of key.display.source) {
                        if (source.xplane_dataref) {
                            dataRefs.add(source.xplane_dataref);
                        }
                    }
                }
            }
        }
    }
    console.log("Found DataRefs:", Array.from(dataRefs));
    return Array.from(dataRefs);
}

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

function updateSimulation() {
    simState.time += 0.05; // Corresponds to 20Hz update rate

    simState.altitude += simState.altitude_dir;
    if (simState.altitude > 20000) simState.altitude_dir = -10;
    if (simState.altitude < 100) simState.altitude_dir = 10;
    simState.vertical_speed = simState.altitude_dir * 200; // Update VSI based on altitude_dir

    simState.airspeed += simState.airspeed_dir * 0.25;
    if (simState.airspeed > 210) simState.airspeed_dir = -1;
    if (simState.airspeed < 67) simState.airspeed_dir = 1;

    simState.bank_angle = Math.sin(simState.time / 2) * 30;
    const turnRate = simState.bank_angle * 0.1;
    simState.heading = (simState.heading + turnRate + 360) % 360;
}

function getValueForDataRef(dataRef: string): number {
    switch (dataRef) {
        case "sim/cockpit2/gauges/indicators/altitude_ft_pilot": return simState.altitude;
        case "sim/cockpit2/gauges/indicators/airspeed_kts_pilot": return simState.airspeed;
        case "sim/cockpit/gyros/phi_ind_ahars_pilot_deg": return simState.bank_angle;
        case "sim/cockpit/gyros/the_ind_ahars_pilot_deg": return 2.5;
        case "sim/cockpit2/gauges/indicators/heading_AHARS_deg_mag_pilot": return simState.heading;
        case "sim/cockpit2/gauges/indicators/slip_deg": return -simState.bank_angle / 10;
        case "sim/cockpit2/gauges/indicators/vvi_fpm_pilot": return simState.vertical_speed;
        default: return 0;
    }
}

async function main() {
    const dataRefs = await getSubscribedDataRefs(profile_file);

    socket.on('error', (err) => {
        console.error(`Socket error:\n${err.stack}`);
        socket.close();
    });

    socket.on('message', (msg, rinfo) => {
        if (msg.subarray(0, 4).toString() === "RREF") {
            if (!client) {
                console.log(`Received first subscription from client ${rinfo.address}:${rinfo.port}. Starting data stream.`);
                client = rinfo;
                startSimulation(dataRefs);
            }
        }
    });

    socket.on('listening', () => {
        const address = socket.address();
        console.log(`Fake X-Plane server listening on ${address.address}:${address.port}`);
        console.log("Run app.ts now. Waiting for it to connect...");
    });

    socket.bind(listenPort, listenHost);
}

function startSimulation(dataRefs: string[]) {
    if (simulationInterval) return;

    simulationInterval = setInterval(() => {
        if (!client) return;
        updateSimulation();

        const packetSize = 5 + dataRefs.length * 8;
        const buffer = Buffer.alloc(packetSize);
        buffer.write("RREF,");
        let offset = 5;

        for (let i = 0; i < dataRefs.length; i++) {
            const dataRef = dataRefs[i];
            const value = getValueForDataRef(dataRef);
            buffer.writeInt32LE(i, offset);
            offset += 4;
            buffer.writeFloatLE(value, offset);
            offset += 4;
        }
        socket.send(buffer, 0, buffer.length, client.port, client.address);
    }, 50); // 20Hz
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
