export interface PageConfig {
    default?: number;
    keys?: KeyConfig[];
    left?: KnobConfig[];
    right?: KnobConfig[];
    color?: string;
}

export interface KeyConfig {
    label?: string | string[];
    size?: number | number[];
    color_bg?: string | string[];
    color_fg?: string | string[];
    sep?: number;
    display?: DisplayConfig;
    pressed?: ActionSpec;
}

export interface KnobConfig {
    label?: string | string[];
    size?: number | number[];
    color_bg?: string | string[];
    color_fg?: string | string[];
    sep?: number;
    pressed?: ActionSpec;
    inc?: ActionSpec;
    dec?: ActionSpec;
}

export interface ActionSpec {
    xplane_cmd?: string;
}

export interface DisplayConfig {
    type?: string;
    source?: SourceConfig[];
    freq?: number;
    min?: number;
    max?: number;
    stops?: StopConfig[];
    fmt?: string | string[];
    exp?: string | string[];
    size?: number | number[];
    color_fg?: string | string[];
    color_bg?: string | string[];
    label?: string | string[];
    navs?: Record<string, NavConfig>;
}

export interface SourceConfig {
    xplane_dataref?: string;
}

export interface StopConfig {
    value_begin: number;
    value_end: number;
    color: string;
}

export interface DeflectionNavConfig {
    def: number;
    display?: number;
    received?: number;
    flag?: number;
}

export interface HsiNavConfig extends DeflectionNavConfig {
    crs: number;
    fromto: number;
    next: string;
    color?: string;
}

export type NavConfig = DeflectionNavConfig | HsiNavConfig;

const isObject = (obj: unknown): obj is Record<string, unknown> => {
    return typeof obj === "object" && obj != null && !Array.isArray(obj);
};

export const isSourceIndex = (x: unknown): x is number => {
    return typeof x === "number" && Number.isFinite(x) && Number.isInteger(x) && x >= 0;
};

export const isDeflectionNavConfig = (obj: unknown): obj is DeflectionNavConfig => {
    return isObject(obj)
        && isSourceIndex(obj.def)
        && (isSourceIndex(obj.display) || isSourceIndex(obj.received) || isSourceIndex(obj.flag));
};

export const isHsiNavConfig = (obj: unknown): obj is HsiNavConfig => {
    return isObject(obj)
        && isSourceIndex(obj.def)
        && (isSourceIndex(obj.display) || isSourceIndex(obj.received))
        && isSourceIndex(obj.crs)
        && isSourceIndex(obj.fromto)
        && typeof obj.next === "string";
};

export interface TextStyles {
    font: string[];
    color_bg: (string | undefined)[];
    color_fg: (string | undefined)[];
}
