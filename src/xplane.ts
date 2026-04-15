import dgram from "node:dgram";

const DEFAULT_STATS_WINDOW_MS = 5000;
const MIN_STATS_WINDOW_MS = 1000;
const RATE_STATS_MARKER = "[xplane-rate]";

interface SubscriptionRateStats {
    label: string;
    windowMs: number;
    windowStart: number;
    received: number;
}

export interface SubscribeDataRefStatsOptions {
    enabled?: boolean;
    label?: string;
    windowMs?: number;
}

export interface SubscribeDataRefOptions {
    stats?: boolean | SubscribeDataRefStatsOptions;
}

interface Subscription {
    dataRef: string;
    freq: number;
    handler: (value: number) => void;
    stats?: SubscriptionRateStats;
}

export class XPlane {
    private socket: dgram.Socket;
    private subscribed: Subscription[];
    private lastReceived: Date | null;
    private statusChecker: NodeJS.Timeout | null;
    private closed: boolean;
    private xplaneAddr: string;
    private xplanePort: number;

    constructor(
        xplaneAddr = "localhost",
        xplanePort = 49000,
        statusCheck = 5000,
        statusTimeout = 1000,
    ) {
        this.socket = dgram.createSocket("udp4");
        this.subscribed = [];
        this.lastReceived = null;
        this.closed = false;
        const xplane = this;
        this.statusChecker = setTimeout(async function statusChecker() {
            if (xplane.closed) {
                return;
            }
            let active = false;
            if (xplane.lastReceived) {
                if (new Date().getTime() - xplane.lastReceived.getTime() < statusTimeout) {
                    active = true;
                }
            }
            if (!active) {
                //console.info(
                //    `x-plane data not detected, will try again in ${(statusCheck / 1000).toFixed(2)} secs`,
                //);
                await xplane._subscribeAll().catch(() => {
                    // Ignore transient transport errors during shutdown/reconnect.
                });
            }
            if (xplane.closed) {
                return;
            }
            xplane.statusChecker = setTimeout(statusChecker, statusCheck);
        }, statusCheck);
        this.xplaneAddr = xplaneAddr;
        this.xplanePort = xplanePort;
        this.socket.on("message", async (msg: Buffer, rinfo: dgram.RemoteInfo) => {
            if (msg.subarray(0, 5).toString() != "RREF,") {
                console.info("dropping unrelated message");
                return;
            }
            this.lastReceived = new Date();
            let num = (msg.length - 5) / 8;
            for (let i = 0; i < num; i++) {
                const idx = msg.readInt32LE(5 + i * 8);
                if (idx < 0) {
                    console.info(`sender index ${idx} should be >= 0`);
                    return;
                }
                if (idx >= this.subscribed.length) {
                    console.info(`sender index ${idx} > subscribed.length`);
                    return;
                }
                const v = msg.readFloatLE(9 + i * 8);
                //console.info(`${this.subscribed[idx].dataRef} = ${v}`);
                const subscription = this.subscribed[idx];
                this.maybeReportRateStats(subscription);
                subscription.handler(v);
            }
        });
        this.socket.bind(0);
    }

    private createRateStats(
        dataRef: string,
        freq: number,
        options?: SubscribeDataRefOptions,
    ): SubscriptionRateStats | undefined {
        const statsOption = options?.stats;
        if (statsOption == null || statsOption === false) {
            return undefined;
        }
        const config = typeof statsOption === "object" ? statsOption : {};
        const enabled = config.enabled == null ? true : config.enabled;
        if (!enabled) {
            return undefined;
        }
        const windowMsRaw = config.windowMs;
        const windowMs = (
            Number.isFinite(windowMsRaw) && (windowMsRaw as number) > 0
                ? Math.floor(windowMsRaw as number)
                : DEFAULT_STATS_WINDOW_MS
        );
        return {
            label: config.label || dataRef,
            windowMs: Math.max(MIN_STATS_WINDOW_MS, windowMs),
            windowStart: Date.now(),
            received: 0,
        };
    }

    private maybeReportRateStats(subscription: Subscription): void {
        const stats = subscription.stats;
        if (!stats) {
            return;
        }
        stats.received++;
        const now = Date.now();
        const elapsedMs = now - stats.windowStart;
        if (elapsedMs < stats.windowMs) {
            return;
        }
        const elapsedSec = elapsedMs / 1000;
        const actualHz = stats.received / elapsedSec;
        console.info(
            `${RATE_STATS_MARKER} x-plane rate[${stats.label}] ${actualHz.toFixed(1)}Hz `
            + `(configured=${subscription.freq}Hz, samples=${stats.received}, window=${elapsedSec.toFixed(1)}s)`,
        );
        stats.windowStart = now;
        stats.received = 0;
    }

    private async _subscribeDataRef(idx: number) {
        const { dataRef, freq } = this.subscribed[idx];
        let buffer = Buffer.alloc(4 + 1 + 4 * 2 + 400);
        let off = buffer.write("RREF");
        off = buffer.writeUInt8(0, off); // null terminated
        off = buffer.writeInt32LE(freq, off); // xint frequency
        off = buffer.writeInt32LE(idx, off); // xint sender index
        off += buffer.write(dataRef, off); // char[400] dataref
        off = buffer.writeUInt8(0, off); // null terminated
        await this.socket.send(
            buffer,
            0,
            buffer.length,
            this.xplanePort,
            this.xplaneAddr,
        );
    }

    private async _subscribeAll() {
        for (let i = 0; i < this.subscribed.length; i++) {
            await this._subscribeDataRef(i);
        }
    }

    public async subscribeDataRef(
        dataRef: string,
        freq: number,
        handler: (value: number) => void,
        options?: SubscribeDataRefOptions,
    ) {
        const idx = this.subscribed.length;
        this.subscribed.push({
            dataRef,
            handler,
            freq,
            stats: this.createRateStats(dataRef, freq, options),
        });
        console.info(`x-plane subscribed[${idx}] => ${dataRef} @${freq}Hz`);
        await this._subscribeDataRef(idx);
    }
    //subscribeDataRef("sim/flightmodel/position/indicated_airspeed");

    public async sendCommand(cmd: string) {
        let buffer = Buffer.alloc(4 + 1 + cmd.length + 1);
        let off = buffer.write("CMND");
        off = buffer.writeUInt8(0, off); // null terminated
        off += buffer.write(cmd, off); // command
        off = buffer.writeUInt8(0, off); // null terminated
        console.info(`x-plane cmd: ${cmd}`);
        await this.socket.send(
            buffer,
            0,
            buffer.length,
            this.xplanePort,
            this.xplaneAddr,
        );
    }
    //sendCommand("sim/GPS/g1000n1_hdg_down");

    public async close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        if (this.statusChecker) {
            clearTimeout(this.statusChecker);
            this.statusChecker = null;
        }
        for (let i = 0; i < this.subscribed.length; i++) {
            this.subscribed[i].freq = 0;
            await this._subscribeDataRef(i).catch(() => {
                // Ignore best-effort unsubscribe failures during close.
            });
        }
        this.subscribed = [];
        await new Promise<void>((resolve) => {
            this.socket.close(() => resolve());
        });
    }
}
