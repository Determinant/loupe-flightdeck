import dgram from "node:dgram";

export class XPlane {
    constructor(xplaneAddr = "localhost", xplanePort = 49000) {
        this.socket = dgram.createSocket("udp4");
        this.subscribed = [];
        this.xplaneAddr = xplaneAddr;
        this.xplanePort = xplanePort;
        this.socket.on("message", (msg, rinfo) => {
            if (msg.subarray(0, 5).toString() != "RREF,") {
                console.info("dropping unrelated message");
                return;
            }
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
                //console.info(`${this.subscribed[idx].ref} = ${v}`);
                this.subscribed[idx].handler(v);
            }
        });
        this.socket.bind(0);
    }

    async subscribeDataRef(dataRef, freq, handler) {
        const idx = this.subscribed.length;
        if (handler) {
            this.subscribed.push({ ref: dataRef, handler });
        }
        let buffer = Buffer.alloc(4 + 1 + 4 * 2 + 400);
        let off = buffer.write("RREF");
        off = buffer.writeUInt8(0, off); // null terminated
        off = buffer.writeInt32LE(freq, off); // xint frequency
        off = buffer.writeInt32LE(idx, off); // xint sender index
        off += buffer.write(dataRef, off); // char[400] dataref
        off = buffer.writeUInt8(0, off); // null terminated
        console.info(`x-plane subscribed[${idx}] => ${dataRef}`);
        await this.socket.send(
            buffer,
            0,
            buffer.length,
            this.xplanePort,
            this.xplaneAddr,
        );
    }
    //subscribeDataRef("sim/flightmodel/position/indicated_airspeed");

    async sendCommand(cmd) {
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
}
