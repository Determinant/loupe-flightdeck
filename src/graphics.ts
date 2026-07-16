import { CanvasRenderingContext2D } from "canvas";
import type { DeflectionNavConfig, DisplayConfig, HsiNavConfig, KeyConfig, KnobConfig, TextStyles } from "./config.js";

export const defaultFont = "B612";
const defaultTextSize = 18;
const invalidDataColor = "red";
const expressionEvaluatorCache = new Map<string, (value: number | null) => number | null>();
const templateEvaluatorCache = new Map<string, (values: (number | null)[]) => string>();

interface DeflectionState {
    def: number | null;
    displayActive: number | null;
    flag: number | null;
}

const isNumber = (x: unknown): x is number => {
    return typeof x === "number" && Number.isFinite(x);
};

const isSourceIndex = (x: unknown): x is number => {
    return isNumber(x) && Number.isInteger(x) && x >= 0;
};

const isObject = (obj: unknown): obj is Record<string, unknown> => {
    return typeof obj === "object" && obj != null && !Array.isArray(obj);
};

const numberOr = (value: number | null | undefined, fallback: number): number => {
    return isNumber(value) ? value : fallback;
};

const isDeflectionNavConfig = (obj: unknown): obj is DeflectionNavConfig => {
    return isObject(obj)
        && isSourceIndex(obj.def)
        && (isSourceIndex(obj.display) || isSourceIndex(obj.received) || isSourceIndex(obj.flag));
};

const isHsiNavConfig = (obj: unknown): obj is HsiNavConfig => {
    return isObject(obj)
        && isSourceIndex(obj.def)
        && (isSourceIndex(obj.display) || isSourceIndex(obj.received))
        && isSourceIndex(obj.crs)
        && isSourceIndex(obj.fromto)
        && typeof obj.next === "string";
};

const sourceValue = (values: (number | null)[], index: number | undefined): number | null => {
    return isSourceIndex(index) ? values[index] ?? null : null;
};

const readDeflectionState = (
    src: DeflectionNavConfig,
    values: (number | null)[],
    legacyReceivedIsFlag = false,
): DeflectionState => {
    const displayIndex = src.display
        ?? (legacyReceivedIsFlag && src.flag == null ? undefined : src.received);
    const flagIndex = src.flag
        ?? (legacyReceivedIsFlag && src.display == null ? src.received : undefined);
    return {
        def: sourceValue(values, src.def),
        displayActive: sourceValue(values, displayIndex),
        flag: sourceValue(values, flagIndex),
    };
};

const deg2Rad = (x: number): number => (x / 180) * Math.PI;

const renderInvalidDataCross = (
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    padding = 0,
    lineWidth = 2,
): void => {
    c.save();
    c.beginPath();
    c.strokeStyle = invalidDataColor;
    c.lineWidth = lineWidth;
    c.moveTo(x + padding, y + padding);
    c.lineTo(x + w - padding, y + h - padding);
    c.moveTo(x + padding, y + h - padding);
    c.lineTo(x + w - padding, y + padding);
    c.stroke();
    c.restore();
};

const getExpressionEvaluator = (exp: string): ((value: number | null) => number | null) => {
    let fn = expressionEvaluatorCache.get(exp);
    if (!fn) {
        fn = Function("$d", `"use strict"; return(${exp});`) as (value: number | null) => number | null;
        expressionEvaluatorCache.set(exp, fn);
    }
    return fn;
};

const getTemplateEvaluator = (fmt: string): ((values: (number | null)[]) => string) => {
    let fn = templateEvaluatorCache.get(fmt);
    if (!fn) {
        fn = Function("$d", `"use strict"; return(\`${fmt}\`);`) as (values: (number | null)[]) => string;
        templateEvaluatorCache.set(fmt, fn);
    }
    return fn;
};

const getTextStyles = (
    conf: KeyConfig | KnobConfig | DisplayConfig,
    lines = 1,
    defaultFg = "#fff",
): TextStyles => {
    const size = Array.isArray(conf.size) ? conf.size : [conf.size];
    const color_bg = Array.isArray(conf.color_bg) ? conf.color_bg : [conf.color_bg];
    const color_fg = Array.isArray(conf.color_fg) ? conf.color_fg : [conf.color_fg];

    return {
        font: Array.from({ length: lines }, (_, i) => `${size[i] ?? size[0] ?? defaultTextSize}px '${defaultFont}'`),
        color_bg: Array.from({ length: lines }, (_, i) => color_bg[i] ?? color_bg[0]),
        color_fg: Array.from({ length: lines }, (_, i) => color_fg[i] ?? color_fg[0] ?? defaultFg),
    };
};

const getLabels = (conf: KeyConfig | KnobConfig | DisplayConfig | string): string[] => {
    let text: string[];
    if (isObject(conf)) {
        text = Array.isArray(conf.label) ? conf.label : [conf.label ?? ""];
    } else {
        text = [conf.toString()];
    }
    return text;
};

const transformValues = (conf: DisplayConfig, values: (number | null)[]): (number | null)[] => {
    let last: string | undefined;
    const exps = Array.isArray(conf.exp) ? conf.exp : [conf.exp];
    let res: (number | null)[] = [];
    for (let i = 0; i < values.length; i++) {
        let exp = exps[i] ?? last;
        if (exp != null) {
            res[i] = getExpressionEvaluator(exp)(values[i]);
        } else {
            res[i] = values[i];
        }
        last = exp;
    }
    return res;
};

const formatValues = (conf: DisplayConfig, values_: (number | null)[], n = 1): { text: string[], values: (number | null)[] } => {
    const values = transformValues(conf, values_);
    const f = (fmt?: string) => {
        if (fmt != null) {
            return getTemplateEvaluator(fmt)(values);
        }
        if (!isNumber(values[0])) {
            return "X";
        }
        return values[0].toFixed(0).toString();
    };

    let last: string | undefined;
    let text: string[] = [];
    const formatter = Array.isArray(conf.fmt) ? conf.fmt : [conf.fmt];
    for (let i = 0; i < n; i++) {
        let fmt = formatter[i] ?? last;
        text.push(f(fmt));
        last = fmt;
    }
    return { text, values };
};

const formatTextColors = (conf: DisplayConfig, values: (number | null)[], n = 1): string[] => {
    const f = (fmt?: string) => {
        if (fmt != null) {
            return getTemplateEvaluator(fmt)(values);
        }
        return "#fff";
    };

    let last: string | undefined;
    let color: string[] = [];
    const formatter = Array.isArray(conf.color_fg) ? conf.color_fg : [conf.color_fg];
    for (let i = 0; i < n; i++) {
        let fmt = formatter[i] ?? last;
        color.push(f(fmt));
        last = fmt;
    }
    return color;
};

const renderMultiLineText = (c: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, text: string[], styles: TextStyles, conf: { sep?: number }) => {
    if (text.length === 0) {
        return;
    }

    const { font, color_fg } = styles;
    c.save();
    let sep = conf.sep;
    if (sep == null) {
        c.font = font[0];
        const mx = c.measureText("x");
        sep = mx.actualBoundingBoxAscent - mx.actualBoundingBoxDescent;
    }
    let ms: ReturnType<CanvasRenderingContext2D["measureText"]>[] = [];
    let totalHeight = 0;
    for (let i = 0; i < text.length; i++) {
        c.font = font[i];
        const m = c.measureText(text[i]);
        ms.push(m);
        totalHeight += m.actualBoundingBoxAscent - m.actualBoundingBoxDescent;
    }
    totalHeight += (text.length - 1) * sep;
    let yBase = y0 + (h - totalHeight) / 2;
    for (let i = 0; i < text.length; i++) {
        const x =
            x0 +
            Math.max(
                0,
                w -
                (ms[i].actualBoundingBoxRight -
                    ms[i].actualBoundingBoxLeft),
            ) /
            2;
        const textHeight =
            ms[i].actualBoundingBoxAscent - ms[i].actualBoundingBoxDescent;
        const y = yBase + textHeight;
        c.font = font[i];
        c.fillStyle = color_fg[i] || "#fff";
        c.fillText(text[i], x, y);
        yBase += textHeight + sep;
    }
    c.restore();
};

export const renderKey = (
    c: CanvasRenderingContext2D,
    conf: KeyConfig | null,
    pressed: boolean,
): void => {
    const padding = 10;
    const bg = pressed ? "white" : "black";
    const fg = pressed ? "black" : "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    c.fillStyle = fg;
    c.lineWidth = 2;
    c.strokeStyle = fg;
    c.strokeRect(padding, padding, w - padding * 2, h - padding * 2);
    if (conf != null) {
        const labels = getLabels(conf);
        const styles = getTextStyles(conf, labels.length, fg);
        renderMultiLineText(c, 0, 0, w, h, labels, styles, conf);
    }
    // otherwise the empty key style is still drawn
};

export const renderSideKnobs = (
    c: CanvasRenderingContext2D,
    confs: KnobConfig[] | undefined,
    light: string,
    highlight?: boolean[],
): void => {
    const mask = highlight || [false, false, false];
    for (let i = 0; i < 3; i++) {
        const hl = mask[i];
        const y_offset = (i * c.canvas.height) / 3;
        const x_padding = 8;
        const y_padding = 3;
        const bg = hl ? light : "black";
        const fg = hl ? "black" : light;
        const w = c.canvas.width;
        const h = c.canvas.height / 3;
        // draw background
        c.fillStyle = bg;
        c.fillRect(0, y_offset, w, h);
        c.fillStyle = fg;
        c.lineWidth = 2;
        c.strokeStyle = fg;
        c.strokeRect(
            x_padding,
            y_padding + y_offset,
            w - x_padding * 2,
            h - y_padding * 2,
        );
        if (Array.isArray(confs) && confs.length > i && confs[i] != null) {
            c.save();
            const text = getLabels(confs[i]);
            const styles = getTextStyles(confs[i], text.length, fg);
            if (styles.color_bg[0]) {
                c.fillStyle = styles.color_bg[0];
                c.fillRect(
                    x_padding + 2,
                    y_padding + y_offset + 2,
                    w - x_padding * 2 - 2,
                    h - y_padding * 2 - 2,
                );
            }
            c.translate(w, y_offset);
            c.rotate(Math.PI / 2);
            const textStyles = {
                ...styles,
                color_bg: [],
                color_fg: hl ? styles.color_fg.map(() => fg) : styles.color_fg,
            };
            renderMultiLineText(
                c,
                0,
                0,
                h,
                w,
                text,
                textStyles,
                confs[i],
            );
            c.restore();
        }
    }
};

const renderTextGauge = (c: CanvasRenderingContext2D, display: DisplayConfig, values_: (number | null)[]): void => {
    const bg = "black";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    const { text, values } = formatValues(display, values_, display.fmt ? (Array.isArray(display.fmt) ? display.fmt.length : 1) : 1);

    // TODO: cache this
    const styles = getTextStyles({
        size: display.size,
        color_fg: formatTextColors(display, values, text.length),
    }, text.length);
    renderMultiLineText(c, 0, 0, w, h, text, { ...styles, color_bg: [] }, {});
};

const renderMeterGauge = (c: CanvasRenderingContext2D, display: DisplayConfig, values_: (number | null)[]): void => {
    const bg = "black";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    const { min, max, stops } = display || {};
    if (min == null || max == null || max <= min) {
        return;
    }

    // Apply display expressions before using the numeric value, so needle and text stay in sync.
    const { text, values } = formatValues(display, values_);
    const span = max - min;
    const rawValue = isNumber(values[0]) ? values[0] : min;
    let reading = (Math.min(Math.max(rawValue, min), max) - min) / span;
    if (!Number.isFinite(reading)) {
        reading = 0;
    }

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);
    c.strokeStyle = fg;
    c.lineWidth = 1;

    const x0 = w / 2;
    const y0 = h / 2 + 5;
    const outer = 40;
    const width = 5;
    const inner = outer - width;

    // draw each arc segments
    if (stops) {
        for (let i = 0; i < stops.length; i++) {
            const theta0 =
                Math.PI * (1 + (stops[i].value_begin - min) / span) + 0.05;
            const theta1 = Math.PI * (1 + (stops[i].value_end - min) / span);

            c.beginPath();
            c.lineWidth = width;
            c.strokeStyle = stops[i].color;
            c.arc(x0, y0, outer - width / 2, theta0, theta1);
            c.stroke();

            c.beginPath();
            c.lineWidth = 2;
            const cos = Math.cos(theta1);
            const sin = Math.sin(theta1);
            c.moveTo(x0 + cos * (inner - 2), y0 + sin * (inner - 2));
            c.lineTo(x0 + cos * (outer + 2), y0 + sin * (outer + 2));
            c.stroke();
        }
    }

    // draw the needle
    c.strokeStyle = fg;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x0, y0);
    const theta = Math.PI * (1 + reading);
    c.lineTo(x0 + Math.cos(theta) * inner, y0 + Math.sin(theta) * inner);
    c.stroke();

    // show the value text
    const { font } = getTextStyles(display);
    c.font = font[0];
    c.fillStyle = fg;
    const m = c.measureText(text[0]);
    c.fillText(text[0], (w - m.width) / 2, h / 2 + 25);
};

const renderAttitudeIndicator = (c: CanvasRenderingContext2D, display: DisplayConfig, values: (number | null)[]): void => {
    const bg = "black";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    c.save();

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    const pitch = values[0];
    const roll = values[1];
    if (!isNumber(pitch) || !isNumber(roll)) {
        renderInvalidDataCross(c, 0, 0, w, h, 10, Math.max(2, Math.min(w, h) * 0.035));
        c.restore();
        return;
    }

    const slip = numberOr(values[2], 0);
    const navSource = isSourceIndex(values[3]) ? values[3] : 0;
    let src = isObject(display.navs) ? display.navs[navSource] : null;
    if (!isDeflectionNavConfig(src)) {
        src = null;
    }
    const vdef = src ? readDeflectionState(src, values, true) : null;

    const x0 = w / 2;
    const y0 = h / 2;
    const longMark = [-10, 10];
    const shortMark = [-5, 5];
    const longSep = 18;
    const shortSep = longSep / 2;

    c.translate(x0, y0);
    c.save();
    c.rotate(deg2Rad(-roll));
    c.save();
    c.translate(0, (pitch / 10) * longSep);

    // draw horizon
    c.fillStyle = "#0077b6";
    c.fillRect(-w, -2 * h, 2 * w, 4 * h);
    c.fillStyle = "#99582a";
    c.fillRect(-w, 0, 2 * w, 4 * h);

    // draw pitch marks
    c.lineWidth = 1;
    c.strokeStyle = fg;
    c.beginPath();
    c.moveTo(-0.75 * w, 0);
    c.lineTo(0.75 * w, 0);
    c.fillStyle = fg;
    c.font = `10px ${defaultFont}`;
    const drawMark = (i: number) => {
        const y = longSep * i;
        const sign = i < 0 ? -1 : 1;
        c.fillText((sign * i * 10).toString(), longMark[0] - 15, y + 3);
        c.moveTo(longMark[0], y);
        c.lineTo(longMark[1], y);
        c.moveTo(shortMark[0], y - sign * shortSep);
        c.lineTo(shortMark[1], y - sign * shortSep);
    };
    for (let i = -6; i <= 6; i++) {
        if (i != 0) {
            drawMark(i);
        }
    }
    c.stroke();

    // draw bank angle arc
    c.restore();
    c.lineWidth = 1;
    c.strokeStyle = fg;
    c.beginPath();
    const bankR = 30;
    const theta0 = deg2Rad(-30);
    const t15 = deg2Rad(-15);
    const t10 = deg2Rad(-10);
    const bankTicks = [10, 5, 10, 5, 5, 5, 5, 5, 10, 5, 10];
    const bankSteps = [t15, t15, t10, t10, t10, t10, t10, t10, t15, t15];
    c.save();
    c.rotate(theta0);
    c.moveTo(bankR, 0);
    c.arc(0, 0, bankR, 0, deg2Rad(-120), true);
    for (let i = 0; i < bankTicks.length; i++) {
        c.moveTo(30, 0);
        c.lineTo(30 + bankTicks[i], 0);
        if (i < bankSteps.length) {
            c.rotate(bankSteps[i]);
        }
    }

    c.restore();
    c.stroke();
    c.beginPath();
    c.lineWidth = 2;
    c.moveTo(-3, -(bankR + 8));
    c.lineTo(0, -bankR);
    c.lineTo(3, -(bankR + 8));
    c.stroke();

    // draw center mark
    c.restore();
    c.lineWidth = 2;
    c.strokeStyle = "yellow";
    c.beginPath();
    c.moveTo(-30, 0);
    c.lineTo(-10, 0);
    c.lineTo(-10, 8);

    c.moveTo(30, 0);
    c.lineTo(10, 0);
    c.lineTo(10, 8);
    c.rect(-1, -1, 2, 2);

    c.moveTo(-3, -(bankR - 9));
    c.lineTo(0, -(bankR - 1));
    c.lineTo(3, -(bankR - 9));

    const slipD = -slip * 2;
    c.moveTo(-5 + slipD, -(bankR - 9));
    c.lineTo(5 + slipD, -(bankR - 9));
    c.stroke();

    // draw vertical deflection dots
    const pi2 = 2 * Math.PI;
    const vdefX = w - 10 - x0;
    const vdefR = 3;

    c.strokeStyle = "white";
    c.lineWidth = 1;
    c.beginPath();
    for (let i = -2; i <= 2; i++) {
        if (i != 0) {
            const vdefY = 13 * i;
            c.moveTo(vdefX + vdefR, vdefY);
            c.arc(vdefX, vdefY, vdefR, 0, pi2);
        }
    }
    c.stroke();

    const showVDef = vdef != null
        && (!isNumber(vdef.displayActive) || vdef.displayActive != 0)
        && (!isNumber(vdef.flag) || vdef.flag == 0);
    if (showVDef) {
        // draw CDI diamond
        const cdiY = 13 * numberOr(vdef.def, 0);
        const cdiH = 7;
        const cdiW = 4;
        c.fillStyle = "#2dfe54";
        c.strokeStyle = "black";
        c.beginPath();
        c.moveTo(vdefX, cdiY + cdiH);
        c.lineTo(vdefX - cdiW, cdiY);
        c.lineTo(vdefX, cdiY - cdiH);
        c.lineTo(vdefX + cdiW, cdiY);
        c.stroke();
        c.fill();
    }
    c.restore();
};

interface MechanicalNumber {
    digits: number[];
    scroll: number[];
    low10: number;
    lowDigits: number;
}

const mechanicalStyleNumber = (value: number, lowDigitStep = 1): MechanicalNumber => {
    const split = (x: number) => {
        const int = Math.trunc(x);
        const float = parseFloat((x - int).toFixed(2));
        return { int, float };
    };

    // first handle the lowest bundle of digits
    const lowDigits = Math.trunc(Math.log10(lowDigitStep)) + 1;
    const low10 = Math.pow(10, lowDigits);
    const lowMax = (low10 - lowDigitStep) / lowDigitStep;
    let t = split((value % low10) / lowDigitStep);
    let digits = [t.int];
    let scroll = [t.float];
    // remove the lowest bundle of digits
    let i = 0;
    value /= low10;
    while (true) {
        t = split(value % 10);
        if (value < 1) {
            if (value > 0.99) {
                scroll.push(scroll[i]);
                digits.push(0);
            }
            break;
        }
        if (
            ((i > 0 && digits[i] == 9) || (i == 0 && digits[i] == lowMax)) &&
            scroll[i] > 0
        ) {
            scroll.push(scroll[i]);
        } else {
            scroll.push(0);
        }
        digits.push(t.int);
        i += 1;
        value /= 10;
    }
    return { digits, scroll, low10, lowDigits };
};

const renderMechanicalDisplay = (
    c: CanvasRenderingContext2D,
    w: number,
    h: number,
    value: number | null,
    padding = 20,
    right = true,
    wideWinWidth = 2,
    lowDigitStep = 1,
    size = defaultTextSize,
): void => {
    const bg = "black";
    const fg = "white";

    c.save();
    c.font = `${size}px '${defaultFont}'`;
    const m = c.measureText("x");
    const y0 =
        h / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    let digitH = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) * 2;
    let digitW = (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) * 1.2;
    const sign = right ? -1 : 1;
    let x = (right ? w : 0) + sign * padding;

    c.strokeStyle = bg;
    const narrowWinY = y0 - digitH * 0.95;
    const narrowWinH = digitH * 1.25;
    const wideWinX = x + sign * (wideWinWidth + (right ? -1 : 0)) * digitW;
    const wideWinY = y0 - digitH * 1.5;
    const wideWinW = wideWinWidth * digitW;
    const wideWinH = digitH * 2.25;
    c.fillStyle = bg;
    c.fillRect(0, narrowWinY, w, narrowWinH);
    c.fillRect(wideWinX, wideWinY, wideWinW, wideWinH);

    c.beginPath();
    c.rect(0, narrowWinY, w, narrowWinH);
    c.rect(wideWinX, wideWinY, wideWinW, wideWinH);
    c.stroke();
    c.clip();
    c.strokeStyle = fg;
    c.fillStyle = fg;

    if (!isNumber(value)) {
        renderInvalidDataCross(c, 0, narrowWinY, w, narrowWinH, 0, 3);
        c.restore();
        return;
    }

    let { digits, scroll, low10, lowDigits } = mechanicalStyleNumber(
        value,
        lowDigitStep,
    );
    const formatLowDigits = (x: number) => x.toFixed(0).padStart(lowDigits, "0");
    x -= (lowDigits - 1) * 12;
    for (let i = 0; i < digits.length; i++) {
        const p = right ? i : digits.length - i - 1;
        const y = y0 + scroll[p] * digitH;
        let d: string | number, m1: string | number, m2: string | number, p1: string | number;
        if (p == 0) {
            let dNum = digits[p] * lowDigitStep;
            let m1Num = (dNum == 0 ? low10 : dNum) - lowDigitStep;
            let m2Num = (m1Num == 0 ? low10 : dNum) - lowDigitStep;
            let p1Num = dNum + lowDigitStep;
            if (p1Num >= low10) {
                p1Num -= low10;
            }
            let p2Num = p1Num + lowDigitStep;
            if (p2Num >= low10) {
                p2Num -= low10;
            }
            d = formatLowDigits(dNum);
            m1 = formatLowDigits(m1Num);
            m2 = formatLowDigits(m2Num);
            p1 = formatLowDigits(p1Num);
            let p2 = formatLowDigits(p2Num);
            c.fillText(p2, x, y - digitH * 2);
        } else {
            d = digits[p];
            m1 = d == 0 ? 9 : d - 1;
            m2 = m1 == 0 ? 9 : m1 - 1;
            p1 = d == 9 ? 0 : d + 1;
        }
        c.fillText(d.toString(), x, y);
        c.fillText(m1.toString(), x, y + digitH);
        c.fillText(m2.toString(), x, y + digitH * 2);
        c.fillText(p1.toString(), x, y - digitH);
        x += sign * digitW;
    }
    c.restore();
};

const renderIAS = (c: CanvasRenderingContext2D, display: DisplayConfig, values: (number | null)[]): void => {
    const bg = "#555";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    const ias = isNumber(values[0]) ? Math.max(values[0], 0) : null;
    renderMechanicalDisplay(c, w, h, ias, 20, true, 1);
};

const renderAltimeter = (c: CanvasRenderingContext2D, display: DisplayConfig, values: (number | null)[]): void => {
    const bg = "#555";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    renderMechanicalDisplay(c, w * 0.6, h, values[0], 5, true, 2, 20, defaultTextSize * 0.8);

    // draw floating vsi window
    const vs = values[1];
    const vsiBgX = w * 0.6 + 2;
    c.fillRect(vsiBgX, 0, w - vsiBgX, h);
    c.fillStyle = "#000";
    const vsiH = 20;
    const vsiX = vsiBgX + 2;
    const vsiY =
        (1 -
            (Math.min(Math.max(isNumber(vs) ? vs : 0, -4000), 4000) + 4000) /
            8000) *
        (h - vsiH);
    c.fillRect(vsiX, vsiY, w - vsiX, vsiH);
    c.fillStyle = fg;
    if (isNumber(vs)) {
        c.font = `8px '${defaultFont}'`;
        c.fillText((Math.trunc(vs / 10) * 10).toString(), vsiX + 2, vsiY + vsiH * 0.8);
    }
    const altB = values[2];
    if (isNumber(altB)) {
        c.fillStyle = "cyan";
        c.font = `12px '${defaultFont}'`;
        c.fillText(altB.toString(), 15, 18);
    }
};

const renderHSI = (
    c: CanvasRenderingContext2D,
    display: DisplayConfig,
    values: (number | null)[],
    onHsiSourceChange?: (command: string) => void,
): void => {
    const bg = "black";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    const x0 = w / 2;
    const y0 = h / 2;
    const r = w / 2 - 5;
    const f1 = 0.8;
    const f2 = 0.9;
    const cdiR = 0.4 * r;
    const vdefR = 3;

    if (!isNumber(values[0])) {
        display.pressed = false;
        renderInvalidDataCross(c, 0, 0, w, h, 10, Math.max(2, Math.min(w, h) * 0.035));
        return;
    }

    c.save();

    const hdg = deg2Rad(values[0]);
    const hdgB = isNumber(values[1]) ? deg2Rad(values[1]) : null;
    const navSource = isSourceIndex(values[2]) ? values[2] : null;
    let src = isObject(display.navs) && navSource != null ? display.navs[navSource] : null;
    if (!isHsiNavConfig(src)) {
        src = null;
    }
    if (display.pressed) {
        display.pressed = false;
        if (src) {
            onHsiSourceChange?.(src.next.toString());
        }
    }
    const crs = src ? deg2Rad(numberOr(values[src.crs], 0)) : null;
    const fromto = src ? values[src.fromto] : null;
    const hdef = src ? readDeflectionState(src, values) : null;
    const def = Math.min(Math.max(isNumber(hdef?.def) ? hdef.def : 0, -3), 3);
    const polarXY = (theta: number, r: number) => {
        const t = -theta - Math.PI / 2;
        const dx = r * Math.cos(t);
        const dy = -r * Math.sin(t);
        return { dx, dy };
    };
    const pi2 = Math.PI * 2;

    c.translate(x0, y0);
    c.rotate(-hdg);
    c.strokeStyle = fg;
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 0; i < 36; i++) {
        const { dx, dy } = polarXY(deg2Rad(i * 10), r);
        const f = (i & 1) == 0 ? f1 : f2;
        c.moveTo(dx, dy);
        c.lineTo(dx * f, dy * f);
    }

    c.fillStyle = fg;
    c.font = `16px '${defaultFont}'`;
    c.fillText("N", -5, -0.5 * r);
    c.stroke();

    if (crs != null) {
        c.rotate(crs);

        c.beginPath();
        for (let i = -2; i <= 2; i++) {
            const r = i == 0 ? 1 : vdefR;
            const x = 13 * i;
            c.moveTo(x + r, 0);
            c.arc(x, 0, r, 0, pi2);
        }
        c.stroke();

        c.beginPath();
        c.lineWidth = 3;
        c.strokeStyle = src?.color ? src.color : "magenta";

        if (isNumber(hdef?.displayActive) && hdef.displayActive != 0) {
            // draw CDI needle
            const cdiX = 13 * def;
            c.moveTo(cdiX, -(cdiR - 1));
            c.lineTo(cdiX, cdiR - 1);
        }

        c.moveTo(0, -r);
        c.lineTo(0, -(cdiR + 1));

        // crs arrowhead
        let y0 = -f1 * r;
        let y1 = 0.8 * y0;
        c.moveTo(0, y0);
        c.lineTo(-5, y1);
        c.lineTo(5, y1);
        c.lineTo(0, y0);

        c.moveTo(0, r);
        c.lineTo(0, cdiR + 1);

        // from/to arrowhead
        if (fromto) {
            let y0 = -cdiR;
            let y1 = 0.4 * y0;
            if (fromto != 1) {
                y0 = -y0;
                y1 = -y1;
            }
            c.moveTo(0, y0);
            c.lineTo(-5, y1);
            c.lineTo(5, y1);
            c.lineTo(0, y0);
        }

        c.rotate(-crs);
    }

    if (hdgB != null) {
        const bugW = 4;
        const bugY1 = -(r - 5);
        const bugY0 = -(r - 8);
        c.stroke();
        c.rotate(hdgB);
        c.lineWidth = 1;
        c.strokeStyle = "white";
        c.fillStyle = "cyan";
        c.beginPath();
        c.moveTo(0, bugY1);
        c.lineTo(-bugW, -(r + 1));
        c.lineTo(-bugW, bugY0);
        c.lineTo(bugW, bugY0);
        c.lineTo(bugW, -(r + 1));
        c.lineTo(0, bugY1);
        c.fill();
    }

    c.stroke();
    c.restore();
};

const renderBarGauge = (c: CanvasRenderingContext2D, display: DisplayConfig, values_: (number | null)[]): void => {
    const bg = "black";
    const fg = "white";
    const w = c.canvas.width;
    const h = c.canvas.height;

    // draw background
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    const slotWidth = 10;
    const slotHeight = 60;
    const barWidth = slotWidth * 0.6;

    const { text, values } = formatValues(display, values_, display.fmt ? (Array.isArray(display.fmt) ? display.fmt.length : 1) : 1);
    const label = getLabels(display);
    // TODO: cache this
    const { font, color_fg } = getTextStyles({
        size: display.size,
        color_fg: formatTextColors(display, values, text.length),
    }, text.length);

    c.save();
    c.rotate(Math.PI / 2);

    let y = -(w - (slotWidth + 10) * text.length) / 2;
    let x = (h - slotHeight) / 2;
    c.strokeStyle = fg;
    for (let i = 0; i < text.length; i++) {
        c.lineWidth = 1;
        c.strokeRect(x, y - barWidth, slotHeight, barWidth);
        const r = Math.max(Math.min(numberOr(values[i], 0), 1), 0);
        c.fillStyle = color_fg[i] || fg;
        const xx = x + slotHeight * (1 - r);
        c.fillRect(xx + 1, y - barWidth + 1, slotHeight * r - 1, barWidth - 1);
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(xx + 1, y + 2);
        c.lineTo(xx + 1, y - barWidth - 2);
        c.stroke();
        c.fillStyle = fg;
        c.font = font[i];
        const t = `${label[i]} ${text[i]}`;
        c.fillText(t, x, y - slotWidth + 2);
        y -= slotWidth + 10;
    }
    c.restore();
};

export type GaugeRenderer = (
    c: CanvasRenderingContext2D,
    display: DisplayConfig,
    values: (number | null)[],
) => void;

interface GaugeRendererOptions {
    onHsiSourceChange?: (command: string) => void;
}

export const getGaugeRenderers = (options: GaugeRendererOptions = {}): Record<string, GaugeRenderer> => {
    const { onHsiSourceChange } = options;
    return {
        meter: renderMeterGauge,
        text: renderTextGauge,
        bar: renderBarGauge,
        attitude: renderAttitudeIndicator,
        ias: renderIAS,
        alt: renderAltimeter,
        hsi: (c, display, values) => renderHSI(c, display, values, onHsiSourceChange),
    };
};
