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
    pressed?: boolean;
}

export interface SourceConfig {
    xplane_dataref?: string;
}

export interface StopConfig {
    value_begin: number;
    value_end: number;
    color: string;
}

export interface NavConfig {
    def: number;
    received: number;
    crs: number;
    fromto: number;
    next: string;
    color?: string;
}

export interface TextStyles {
    font: string[];
    color_bg: (string | undefined)[];
    color_fg: (string | undefined)[];
}
