import { registerFont } from 'canvas';

registerFont('./ocr-a-ext.ttf', { family: 'ocr' });

import { discover } from 'loupedeck'

import { readFile } from 'fs/promises';
import { parse } from 'yaml'

const pages = parse(await readFile("./profile.yaml", "utf8"));

// Detects and opens first connected device
const device = await discover()

const isObject = (obj) => {
    return obj != null && obj.constructor.name === "Object"
};

const rectifyLabel = (label) => {
    let text;
    let font;
    if (isObject(label)) {
        text = label.text;
        font = `${label.size}px ocr`;
    } else {
        text = label.toString();
        font = "24px ocr";
    }
    return { text, font }
}

const drawKey = (key, label, down) => {
    device.drawKey(key, (c) => {
        const { text, font } = rectifyLabel(label);
        const padding = 10;
        const bg = down ? "white" : "black";
        const fg = down ? "black" : "white";
        const w = c.canvas.width;
        const h = c.canvas.height;
        c.fillStyle = bg;
        c.fillRect(0, 0, w, h);
        c.fillStyle = fg;
        c.lineWidth = 2;
        c.strokeStyle = fg;
        c.strokeRect(padding, padding, w - padding * 2, h - padding * 2);
        c.font = font;
        const { width, actualBoundingBoxAscent, actualBoundingBoxDescent } = c.measureText(text);
        const x_axis = (w - width) / 2;
        const y_axis = h / 2 + (actualBoundingBoxAscent - actualBoundingBoxDescent) / 2;
        c.fillText(text, x_axis, y_axis);
    })
};

const drawSideKnobs = (side, labels, highlight) => {
    device.drawScreen(side, (c) => {
        if (!highlight) {
            highlight = [false, false, false];
        }
        for (let i = 0; i < 3; i++) {
            const hl = highlight[i];
            const y_offset = i * c.canvas.height / 3;
            const x_padding = 8;
            const y_padding = 3;
            const bg = hl ? "white" : "black";
            const fg = hl ? "black" : "white";
            const w = c.canvas.width;
            const h = c.canvas.height / 3;
            c.fillStyle = bg;
            c.fillRect(0, y_offset, w, h);
            c.fillStyle = fg;
            c.lineWidth = 2;
            c.strokeStyle = fg;
            c.strokeRect(x_padding, y_padding + y_offset, w - x_padding * 2, h - y_padding * 2);
            const { text, font } = rectifyLabel(labels[i]);
            c.font = font;
            const { width, actualBoundingBoxAscent, actualBoundingBoxDescent } = c.measureText(text);
            const x_axis = (h - width) / 2;
            const y_axis = w / 2 + (actualBoundingBoxAscent - actualBoundingBoxDescent) / 2;
            c.rotate(90 * Math.PI / 180);
            c.fillText(text, x_axis + y_offset, -(w - y_axis));
            c.resetTransform();
        }
    })
};

const loadPage = (page) => {
    const { left, right, keys } = page || {};
    if (!left) {
        return
    }
    drawSideKnobs('left', left);
    drawSideKnobs('right', right);
    for (let i = 0; i < 12; i++) {
        drawKey(i, keys[i], false);
    }
};

let currentPage;
let pressed = new Set();
let highlighted = new Set();

// Observe connect events
device.on('connect', () => {
    console.info('Connection successful!')
    currentPage = 1;
    loadPage(pages[currentPage]);
})

// React to button presses
device.on('down', ({ id }) => {
    console.info(`switch to page: ${id}`)
    if (id == 0) {
        return
    }
    currentPage = id;
    loadPage(pages[currentPage]);
})

// React to knob turns
device.on('rotate', ({ id, delta }) => {
    const { left, right, keys } = pages[currentPage] || {};
    if (!left) {
        return
    }
    let pos = {"T": 0, "C": 1, "B": 2}[id.substring(4, 5)];
    let side = {"L": ['left', left], "R": ['right', right]}[id.substring(5, 6)];
    let mask = [false, false, false];
    mask[pos] = true;
    drawSideKnobs(side[0], side[1], mask);
    if (!highlighted.has(id)) {
        highlighted.add(id);
        setTimeout(() => {
            drawSideKnobs(side[0], side[1], [false, false, false]);
            highlighted.delete(id);
        }, 200);
    }
})

const clearStaleButton = (touches) => {
    const s = new Set(touches.map(o => o.target.key).filter(k => k !== undefined));
    for (const key of pressed.keys()) {
        if (!s.has(key)) {
            drawKey(key, pages[currentPage].keys[key], false);
            pressed.delete(key);
        }
    }
};

device.on('touchstart', ({ changedTouches, touches }) => {
    clearStaleButton(changedTouches);
    const target = changedTouches[0].target;
    if (target.key === undefined) {
        return
    }
    pressed.add(target.key);
    drawKey(target.key, pages[currentPage].keys[target.key], true);
    //device.vibrate()
})

device.on('touchmove', ({ changedTouches, touches }) => {
    clearStaleButton(changedTouches);
})

device.on('touchend', ({ changedTouches, touches }) => {
    clearStaleButton(changedTouches);
    const target = changedTouches[0].target;
    if (target.key === undefined) {
        return
    }
    pressed.delete(target.key);
    drawKey(target.key, pages[currentPage].keys[target.key], false)
})

process.on('SIGINT', () => {
    device.close().then(() => {
        console.info("shutdown")
        process.exit()
    })
})
