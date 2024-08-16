import dgram from "node:dgram";

const xplaneAddr = "localhost";
const xplanePort = 49000;
const socket = dgram.createSocket("udp4");

socket.on("message", (msg, rinfo) => {
    console.log(msg, rinfo);
});

socket.bind(10080);

export const subscribeDataRef = async (dataRef) => {
    //const dataRef = "sim/flightmodel/position/indicated_airspeed";
    let buffer = Buffer.alloc(4 + 1 + 4 * 2 + 400);
    let off = buffer.write("RREF");
    off = buffer.writeUInt8(0, off); // null terminated
    off = buffer.writeInt32LE(1, off); // xint frequency
    off = buffer.writeInt32LE(0, off); // xint client
    off += buffer.write(dataRef, off); // char[400] dataref
    off = buffer.writeUInt8(0, off); // null terminated
    console.info(`x-plane dataref: ${dataRef}`);
    await socket.send(buffer, 0, buffer.length, xplanePort, xplaneAddr);
};

export const sendCommand = async (cmd) => {
    let buffer = Buffer.alloc(4 + 1 + cmd.length + 1);
    let off = buffer.write("CMND");
    off = buffer.writeUInt8(0, off); // null terminated
    off += buffer.write(cmd, off); // command
    off = buffer.writeUInt8(0, off); // null terminated
    console.info(`x-plane cmd: ${cmd}`);
    await socket.send(buffer, 0, buffer.length, xplanePort, xplaneAddr);
};

//sendCommand("sim/GPS/g1000n1_hdg_down");
