/*!
 * AV1 open bitstream units: the sequence header, the frame headers of intra frames and the tile groups, ported from
 * dav1d (src/obu.c, src/getbits.c). Copyright (c) 2018-2019, VideoLAN and dav1d authors, BSD-2-Clause License (see
 * THIRD_PARTY_NOTICES.md)
 */

/** Reads the bits of a header, most significant first */
export class BitReader {
    private pos: number;

    constructor(private data: Uint8Array, start: number, private end: number) {
        this.pos = start * 8;
    }

    bit(): number {
        if (this.pos >= this.end * 8) throw new Error('AV1: truncated header');
        const v = this.data[this.pos >> 3] >> (7 - (this.pos & 7)) & 1;
        this.pos++;
        return v;
    }

    bits(n: number): number {
        let v = 0;
        for (let i = 0; i < n; i++) v = v * 2 + this.bit();
        return v;
    }

    /** signed, n bits and a sign (su(1 + n)) */
    sbits(n: number): number {
        const v = this.bits(n + 1);
        return v >= 2 ** n ? v - 2 ** (n + 1) : v;
    }

    uvlc(): number {
        let zeros = 0;
        while (!this.bit()) if (++zeros >= 32) return 0xffffffff;
        return 2 ** zeros - 1 + this.bits(zeros);
    }

    /** ns(max): 0..max-1 */
    uniform(max: number): number {
        let l = 0;
        while (2 ** l <= max) l++;
        const m = 2 ** l - max;
        const v = this.bits(l - 1);
        return v < m ? v : (v << 1) - m + this.bit();
    }

    leb128(): number {
        let v = 0;
        for (let i = 0; i < 8; i++) {
            const b = this.bits(8);
            v += (b & 0x7f) * 2 ** (i * 7);
            if (!(b & 0x80)) return v;
        }
        throw new Error('AV1: invalid leb128');
    }

    align(): void {
        this.pos = this.pos + 7 & ~7;
    }

    /** the byte position (after aligning) */
    get byte(): number {
        return this.pos + 7 >> 3;
    }
}

export interface SequenceHeader {
    profile: number;
    reducedStillPicture: boolean;
    maxWidth: number;
    maxHeight: number;
    widthBits: number;
    heightBits: number;
    frameIdBits: number;
    deltaFrameIdBits: number;
    decoderModelInfo: boolean;
    equalPictureInterval: boolean;
    bufferRemovalDelayLength: number;
    framePresentationDelayLength: number;
    /** per operating point: its idc and whether it has decoder model parameters */
    operatingPoints: Array<{ idc: number, decoderModel: boolean }>;
    sb128: boolean;
    filterIntra: boolean;
    intraEdgeFilter: boolean;
    /** 0, 1, or 2: chosen per frame */
    screenContentTools: number;
    forceIntegerMv: number;
    orderHintBits: number;
    superres: boolean;
    cdef: boolean;
    restoration: boolean;
    bitDepth: number;
    monochrome: boolean;
    colorPrimaries: number;
    transferCharacteristics: number;
    matrixCoefficients: number;
    fullRange: boolean;
    ssx: number;
    ssy: number;
    separateUvDeltaQ: boolean;
    filmGrain: boolean;
}

const ADAPTIVE = 2;

export function parseSequenceHeader(r: BitReader): SequenceHeader {
    const profile = r.bits(3);
    if (profile > 2) throw new Error(`AV1: unsupported profile ${profile}`);
    r.bit(); // still_picture
    const reducedStillPicture = !!r.bit();
    const operatingPoints: SequenceHeader['operatingPoints'] = [];
    let decoderModelInfo = false, equalPictureInterval = false, bufferDelayLength = 0, bufferRemovalDelayLength = 0, framePresentationDelayLength = 0;
    if (reducedStillPicture) {
        r.bits(5); // level
        operatingPoints.push({ idc: 0, decoderModel: false });
    } else {
        if (r.bit()) {
            // timing info
            r.bits(32); r.bits(32);
            equalPictureInterval = !!r.bit();
            if (equalPictureInterval) r.uvlc();
            decoderModelInfo = !!r.bit();
            if (decoderModelInfo) {
                bufferDelayLength = r.bits(5) + 1;
                r.bits(32);
                bufferRemovalDelayLength = r.bits(5) + 1;
                framePresentationDelayLength = r.bits(5) + 1;
            }
        }
        const displayModelInfo = !!r.bit();
        const count = r.bits(5) + 1;
        for (let i = 0; i < count; i++) {
            const idc = r.bits(12);
            const level = r.bits(5);
            if (level >> 2 > 1) r.bit(); // tier (major level > 3)
            let decoderModel = false;
            if (decoderModelInfo && (decoderModel = !!r.bit())) {
                r.bits(bufferDelayLength); r.bits(bufferDelayLength); r.bit();
            }
            if (displayModelInfo && r.bit()) r.bits(4);
            operatingPoints.push({ idc, decoderModel });
        }
    }

    const widthBits = r.bits(4) + 1, heightBits = r.bits(4) + 1;
    const maxWidth = r.bits(widthBits) + 1, maxHeight = r.bits(heightBits) + 1;
    let frameIdBits = 0, deltaFrameIdBits = 0;
    if (!reducedStillPicture && r.bit()) {
        deltaFrameIdBits = r.bits(4) + 2;
        frameIdBits = r.bits(3) + deltaFrameIdBits + 1;
    }
    const sb128 = !!r.bit(), filterIntra = !!r.bit(), intraEdgeFilter = !!r.bit();
    let screenContentTools = ADAPTIVE, forceIntegerMv = ADAPTIVE, orderHintBits = 0;
    if (!reducedStillPicture) {
        r.bit(); r.bit(); r.bit(); r.bit(); // inter intra, masked compound, warped motion, dual filter
        const orderHint = r.bit();
        if (orderHint) { r.bit(); r.bit(); } // jnt comp, ref frame mvs
        screenContentTools = r.bit() ? ADAPTIVE : r.bit();
        forceIntegerMv = screenContentTools ? (r.bit() ? ADAPTIVE : r.bit()) : ADAPTIVE;
        if (orderHint) orderHintBits = r.bits(3) + 1;
    }
    const superres = !!r.bit(), cdef = !!r.bit(), restoration = !!r.bit();

    // color config
    let bitDepth = 8;
    if (r.bit()) bitDepth = profile === 2 && r.bit() ? 12 : 10;
    const monochrome = profile !== 1 && !!r.bit();
    let colorPrimaries = 2, transferCharacteristics = 2, matrixCoefficients = 2;
    if (r.bit()) {
        colorPrimaries = r.bits(8);
        transferCharacteristics = r.bits(8);
        matrixCoefficients = r.bits(8);
    }
    let fullRange: boolean, ssx = 1, ssy = 1;
    if (monochrome) fullRange = !!r.bit();
    else if (colorPrimaries === 1 && transferCharacteristics === 13 && matrixCoefficients === 0) {
        // sRGB: 4:4:4
        fullRange = true;
        ssx = ssy = 0;
    } else {
        fullRange = !!r.bit();
        if (profile === 1) ssx = ssy = 0;
        else if (profile === 2) {
            if (bitDepth === 12) {
                ssx = r.bit();
                ssy = ssx ? r.bit() : 0;
            } else ssy = 0;
        }
        if (ssx && ssy) r.bits(2); // chroma sample position
    }
    const separateUvDeltaQ = !monochrome && !!r.bit();
    const filmGrain = !!r.bit();

    return {
        profile, reducedStillPicture, maxWidth, maxHeight, widthBits, heightBits, frameIdBits, deltaFrameIdBits,
        decoderModelInfo, equalPictureInterval, bufferRemovalDelayLength, framePresentationDelayLength, operatingPoints,
        sb128, filterIntra, intraEdgeFilter, screenContentTools, forceIntegerMv, orderHintBits, superres, cdef,
        restoration, bitDepth, monochrome, colorPrimaries, transferCharacteristics, matrixCoefficients, fullRange,
        ssx, ssy, separateUvDeltaQ, filmGrain
    };
}

export interface SegmentData {
    deltaQ: number;
    deltaLf: number[]; // y vertical, y horizontal, u, v
    ref: number;
    skip: boolean;
    globalMv: boolean;
}

export interface FilmGrain {
    seed: number;
    yPoints: number[][];
    chromaScalingFromLuma: boolean;
    uvPoints: number[][][];
    scalingShift: number;
    arCoeffLag: number;
    arCoeffsY: number[];
    arCoeffsUv: number[][];
    arCoeffShift: number;
    grainScaleShift: number;
    uvMult: number[];
    uvLumaMult: number[];
    uvOffset: number[];
    overlap: boolean;
    clipToRestrictedRange: boolean;
}

export interface FrameHeader {
    showExistingFrame: boolean;
    existingFrameIdx: number;
    frameType: number;
    showFrame: boolean;
    refreshFrameFlags: number;
    disableCdfUpdate: boolean;
    allowScreenContentTools: boolean;
    allowIntrabc: boolean;
    /** the coded width (before superres upscaling), the upscaled width, the height */
    width: number;
    upscaledWidth: number;
    height: number;
    superresDenominator: number;
    tiles: {
        cols: number;
        rows: number;
        log2Cols: number;
        log2Rows: number;
        colStarts: number[];
        rowStarts: number[];
        contextUpdateId: number;
        sizeBytes: number;
    };
    quant: {
        yac: number;
        ydcDelta: number;
        udcDelta: number;
        uacDelta: number;
        vdcDelta: number;
        vacDelta: number;
        qm: boolean;
        qmY: number;
        qmU: number;
        qmV: number;
    };
    segmentation: {
        enabled: boolean;
        updateMap: boolean;
        data: SegmentData[];
        preskip: boolean;
        lastActiveSegId: number;
        qidx: number[];
        lossless: boolean[];
    };
    allLossless: boolean;
    deltaQ: { present: boolean, resLog2: number };
    deltaLf: { present: boolean, resLog2: number, multi: boolean };
    loopFilter: {
        levelY: number[];
        levelU: number;
        levelV: number;
        sharpness: number;
        modeRefDeltaEnabled: boolean;
        refDeltas: number[];
        modeDeltas: number[];
    };
    cdef: { damping: number, bits: number, yStrengths: number[], uvStrengths: number[] };
    restoration: { types: number[], unitSizeLog2: number[] };
    /** 0: 4x4 only, 1: largest, 2: switchable */
    txMode: number;
    reducedTxSet: boolean;
    filmGrain: FilmGrain | null;
}

export const FRAME_KEY = 0, FRAME_INTRA_ONLY = 2;

/** Thrown for frames that use other frames (inter frames), which aren't supported */
export class InterFrameError extends Error {}
export const RESTORATION_NONE = 0, RESTORATION_SWITCHABLE = 1, RESTORATION_WIENER = 2, RESTORATION_SGRPROJ = 3;

const tileLog2 = (size: number, target: number): number => {
    let k = 0;
    while (size << k < target) k++;
    return k;
};

/**
 * Parses the frame header of a frame that doesn't use other frames: key frames and intra only frames (inter frames
 * throw)
 */
export function parseFrameHeader(r: BitReader, seq: SequenceHeader, temporalId: number, spatialId: number): FrameHeader {
    const reduced = seq.reducedStillPicture;
    const showExistingFrame = !reduced && !!r.bit();
    const header = { showExistingFrame } as FrameHeader;
    if (showExistingFrame) {
        header.existingFrameIdx = r.bits(3);
        if (seq.decoderModelInfo && !seq.equalPictureInterval) r.bits(seq.framePresentationDelayLength);
        if (seq.frameIdBits) r.bits(seq.frameIdBits);
        return header;
    }

    const frameType = reduced ? FRAME_KEY : r.bits(2);
    if (frameType !== FRAME_KEY && frameType !== FRAME_INTRA_ONLY) throw new InterFrameError('AV1: inter frames are not supported');
    const showFrame = reduced || !!r.bit();
    let showable = false;
    if (showFrame) {
        if (seq.decoderModelInfo && !seq.equalPictureInterval) r.bits(seq.framePresentationDelayLength);
    } else showable = !!r.bit();
    const errorResilient = frameType === FRAME_KEY && showFrame || reduced || !!r.bit();
    const disableCdfUpdate = !!r.bit();
    const allowScreenContentTools = !!(seq.screenContentTools === ADAPTIVE ? r.bit() : seq.screenContentTools);
    if (allowScreenContentTools && seq.forceIntegerMv === ADAPTIVE) r.bit();
    if (seq.frameIdBits) r.bits(seq.frameIdBits);
    const frameSizeOverride = !reduced && !!r.bit();
    if (seq.orderHintBits) r.bits(seq.orderHintBits);

    if (seq.decoderModelInfo && r.bit()) {
        // buffer removal times
        for (const op of seq.operatingPoints) {
            if (!op.decoderModel) continue;
            const inTemporal = op.idc >> temporalId & 1, inSpatial = op.idc >> spatialId + 8 & 1;
            if (!op.idc || inTemporal && inSpatial) r.bits(seq.bufferRemovalDelayLength);
        }
    }

    const refreshFrameFlags = frameType === FRAME_KEY && showFrame ? 0xff : r.bits(8);
    // (the references' order hints)
    if (refreshFrameFlags !== 0xff && errorResilient && seq.orderHintBits) for (let i = 0; i < 8; i++) r.bits(seq.orderHintBits);

    // frame size
    let upscaledWidth = seq.maxWidth, height = seq.maxHeight;
    if (frameSizeOverride) {
        upscaledWidth = r.bits(seq.widthBits) + 1;
        height = r.bits(seq.heightBits) + 1;
    }
    let superresDenominator = 8, width = upscaledWidth;
    if (seq.superres && r.bit()) {
        superresDenominator = 9 + r.bits(3);
        width = Math.max(Math.floor((upscaledWidth * 8 + (superresDenominator >> 1)) / superresDenominator), Math.min(16, upscaledWidth));
    }
    if (r.bit()) { r.bits(16); r.bits(16); } // render size
    const allowIntrabc = allowScreenContentTools && superresDenominator === 8 && !!r.bit();

    if (!reduced && !disableCdfUpdate) r.bit(); // disable frame end update cdf

    // tiles
    const uniform = r.bit();
    const sbLog2 = seq.sb128 ? 7 : 6;
    const sbw = width + (1 << sbLog2) - 1 >> sbLog2, sbh = height + (1 << sbLog2) - 1 >> sbLog2;
    const maxTileWidthSb = 4096 >> sbLog2;
    let maxTileAreaSb = 4096 * 2304 >> 2 * sbLog2;
    const minLog2Cols = tileLog2(maxTileWidthSb, sbw);
    const maxLog2Cols = tileLog2(1, Math.min(sbw, 64)), maxLog2Rows = tileLog2(1, Math.min(sbh, 64));
    const minLog2Tiles = Math.max(tileLog2(maxTileAreaSb, sbw * sbh), minLog2Cols);
    const colStarts: number[] = [], rowStarts: number[] = [];
    let log2Cols: number, log2Rows: number;
    if (uniform) {
        for (log2Cols = minLog2Cols; log2Cols < maxLog2Cols && r.bit(); log2Cols++);
        const tileW = 1 + (sbw - 1 >> log2Cols);
        for (let x = 0; x < sbw; x += tileW) colStarts.push(x);
        const minLog2Rows = Math.max(minLog2Tiles - log2Cols, 0);
        for (log2Rows = minLog2Rows; log2Rows < maxLog2Rows && r.bit(); log2Rows++);
        const tileH = 1 + (sbh - 1 >> log2Rows);
        for (let y = 0; y < sbh; y += tileH) rowStarts.push(y);
    } else {
        let widest = 0;
        for (let x = 0; x < sbw && colStarts.length < 64;) {
            const size = Math.min(sbw - x, maxTileWidthSb);
            const w = size > 1 ? 1 + r.uniform(size) : 1;
            colStarts.push(x);
            x += w;
            widest = Math.max(widest, w);
        }
        log2Cols = tileLog2(1, colStarts.length);
        maxTileAreaSb = sbw * sbh;
        if (minLog2Tiles) maxTileAreaSb >>= minLog2Tiles + 1;
        const maxTileHeightSb = Math.max(Math.floor(maxTileAreaSb / widest), 1);
        for (let y = 0; y < sbh && rowStarts.length < 64;) {
            const size = Math.min(sbh - y, maxTileHeightSb);
            const h = size > 1 ? 1 + r.uniform(size) : 1;
            rowStarts.push(y);
            y += h;
        }
        log2Rows = tileLog2(1, rowStarts.length);
    }
    const cols = colStarts.length, rows = rowStarts.length;
    colStarts.push(sbw);
    rowStarts.push(sbh);
    let contextUpdateId = 0, sizeBytes = 0;
    if (log2Cols || log2Rows) {
        contextUpdateId = r.bits(log2Cols + log2Rows);
        if (contextUpdateId >= cols * rows) throw new Error('AV1: invalid tile info');
        sizeBytes = r.bits(2) + 1;
    }

    // quantization
    const delta = (): number => r.bit() ? r.sbits(6) : 0;
    const yac = r.bits(8), ydcDelta = delta();
    let udcDelta = 0, uacDelta = 0, vdcDelta = 0, vacDelta = 0;
    if (!seq.monochrome) {
        const diffUv = seq.separateUvDeltaQ && !!r.bit();
        udcDelta = delta(); uacDelta = delta();
        if (diffUv) { vdcDelta = delta(); vacDelta = delta(); } else { vdcDelta = udcDelta; vacDelta = uacDelta; }
    }
    const qm = !!r.bit();
    let qmY = 15, qmU = 15, qmV = 15;
    if (qm) {
        qmY = r.bits(4);
        qmU = r.bits(4);
        qmV = seq.separateUvDeltaQ ? r.bits(4) : qmU;
    }

    // segmentation (intra frames have no primary reference frame: the map and the data are always updated)
    const segmentData: SegmentData[] = [];
    const enabled = !!r.bit();
    let preskip = false, lastActiveSegId = -1;
    for (let i = 0; i < 8; i++) {
        const seg: SegmentData = { deltaQ: 0, deltaLf: [0, 0, 0, 0], ref: -1, skip: false, globalMv: false };
        if (enabled) {
            if (r.bit()) { seg.deltaQ = r.sbits(8); lastActiveSegId = i; }
            for (let k = 0; k < 4; k++) if (r.bit()) { seg.deltaLf[k] = r.sbits(6); lastActiveSegId = i; }
            if (r.bit()) { seg.ref = r.bits(3); lastActiveSegId = i; preskip = true; }
            if ((seg.skip = !!r.bit())) { lastActiveSegId = i; preskip = true; }
            if ((seg.globalMv = !!r.bit())) { lastActiveSegId = i; preskip = true; }
        }
        segmentData.push(seg);
    }

    const deltaQPresent = yac ? !!r.bit() : false;
    const deltaQResLog2 = deltaQPresent ? r.bits(2) : 0;
    const deltaLfPresent = deltaQPresent && !allowIntrabc && !!r.bit();
    const deltaLfResLog2 = deltaLfPresent ? r.bits(2) : 0;
    const deltaLfMulti = deltaLfPresent && !!r.bit();

    const deltaLossless = !ydcDelta && !udcDelta && !uacDelta && !vdcDelta && !vacDelta;
    const qidx: number[] = [], lossless: boolean[] = [];
    let allLossless = true;
    for (let i = 0; i < 8; i++) {
        qidx.push(enabled ? Math.min(255, Math.max(0, yac + segmentData[i].deltaQ)) : yac);
        lossless.push(!qidx[i] && deltaLossless);
        allLossless &&= lossless[i];
    }

    // loop filter
    const loopFilter = { levelY: [0, 0], levelU: 0, levelV: 0, sharpness: 0, modeRefDeltaEnabled: true, refDeltas: [1, 0, 0, 0, -1, 0, -1, -1], modeDeltas: [0, 0] };
    if (!allLossless && !allowIntrabc) {
        loopFilter.levelY = [r.bits(6), r.bits(6)];
        if (!seq.monochrome && (loopFilter.levelY[0] || loopFilter.levelY[1])) {
            loopFilter.levelU = r.bits(6);
            loopFilter.levelV = r.bits(6);
        }
        loopFilter.sharpness = r.bits(3);
        loopFilter.modeRefDeltaEnabled = !!r.bit();
        if (loopFilter.modeRefDeltaEnabled && r.bit()) {
            for (let i = 0; i < 8; i++) if (r.bit()) loopFilter.refDeltas[i] = r.sbits(6);
            for (let i = 0; i < 2; i++) if (r.bit()) loopFilter.modeDeltas[i] = r.sbits(6);
        }
    }

    // cdef
    const cdef = { damping: 3, bits: 0, yStrengths: [0], uvStrengths: [0] };
    if (!allLossless && seq.cdef && !allowIntrabc) {
        cdef.damping = r.bits(2) + 3;
        cdef.bits = r.bits(2);
        cdef.yStrengths = [];
        cdef.uvStrengths = [];
        for (let i = 0; i < 1 << cdef.bits; i++) {
            cdef.yStrengths.push(r.bits(6));
            cdef.uvStrengths.push(seq.monochrome ? 0 : r.bits(6));
        }
    }

    // loop restoration
    const restoration = { types: [RESTORATION_NONE, RESTORATION_NONE, RESTORATION_NONE], unitSizeLog2: [8, 8] };
    if ((!allLossless || superresDenominator !== 8) && seq.restoration && !allowIntrabc) {
        restoration.types[0] = r.bits(2);
        if (!seq.monochrome) {
            restoration.types[1] = r.bits(2);
            restoration.types[2] = r.bits(2);
        }
        if (restoration.types.some(t => t)) {
            let size = 6 + (seq.sb128 ? 1 : 0);
            if (r.bit()) {
                size++;
                if (!seq.sb128) size += r.bit();
            }
            restoration.unitSizeLog2 = [size, size];
            if ((restoration.types[1] || restoration.types[2]) && seq.ssx && seq.ssy) restoration.unitSizeLog2[1] -= r.bit();
        }
    }

    const txMode = allLossless ? 0 : r.bit() ? 2 : 1;
    const reducedTxSet = !!r.bit();

    // film grain
    let filmGrain: FilmGrain | null = null;
    if (seq.filmGrain && (showFrame || showable) && r.bit()) {
        const seed = r.bits(16);
        const yPoints: number[][] = [];
        const numY = r.bits(4);
        if (numY > 14) throw new Error('AV1: invalid film grain');
        for (let i = 0; i < numY; i++) {
            yPoints.push([r.bits(8), r.bits(8)]);
            if (i && yPoints[i - 1][0] >= yPoints[i][0]) throw new Error('AV1: invalid film grain');
        }
        const chromaScalingFromLuma = !seq.monochrome && !!r.bit();
        const uvPoints: number[][][] = [[], []];
        if (!seq.monochrome && !chromaScalingFromLuma && !(seq.ssx && seq.ssy && !numY)) {
            for (let pl = 0; pl < 2; pl++) {
                const n = r.bits(4);
                if (n > 10) throw new Error('AV1: invalid film grain');
                for (let i = 0; i < n; i++) {
                    uvPoints[pl].push([r.bits(8), r.bits(8)]);
                    if (i && uvPoints[pl][i - 1][0] >= uvPoints[pl][i][0]) throw new Error('AV1: invalid film grain');
                }
            }
        }
        if (seq.ssx && seq.ssy && !uvPoints[0].length !== !uvPoints[1].length) throw new Error('AV1: invalid film grain');
        const scalingShift = r.bits(2) + 8;
        const arCoeffLag = r.bits(2);
        const numPos = 2 * arCoeffLag * (arCoeffLag + 1);
        const arCoeffsY: number[] = [];
        for (let i = 0; i < numPos; i++) arCoeffsY.push(numY ? r.bits(8) - 128 : 0);
        const arCoeffsUv: number[][] = [[], []];
        for (let pl = 0; pl < 2; pl++) {
            if (uvPoints[pl].length || chromaScalingFromLuma) {
                const n = numPos + (numY ? 1 : 0);
                for (let i = 0; i < n; i++) arCoeffsUv[pl].push(r.bits(8) - 128);
                if (!numY) arCoeffsUv[pl].push(0);
            }
        }
        const arCoeffShift = r.bits(2) + 6;
        const grainScaleShift = r.bits(2);
        const uvMult = [0, 0], uvLumaMult = [0, 0], uvOffset = [0, 0];
        for (let pl = 0; pl < 2; pl++) {
            if (uvPoints[pl].length) {
                uvMult[pl] = r.bits(8) - 128;
                uvLumaMult[pl] = r.bits(8) - 128;
                uvOffset[pl] = r.bits(9) - 256;
            }
        }
        const overlap = !!r.bit(), clipToRestrictedRange = !!r.bit();
        filmGrain = {
            seed, yPoints, chromaScalingFromLuma, uvPoints, scalingShift, arCoeffLag, arCoeffsY, arCoeffsUv, arCoeffShift,
            grainScaleShift, uvMult, uvLumaMult, uvOffset, overlap, clipToRestrictedRange
        };
    }

    return Object.assign(header, {
        existingFrameIdx: 0, frameType, showFrame, refreshFrameFlags, disableCdfUpdate, allowScreenContentTools, allowIntrabc,
        width, upscaledWidth, height, superresDenominator,
        tiles: { cols, rows, log2Cols, log2Rows, colStarts, rowStarts, contextUpdateId, sizeBytes },
        quant: { yac, ydcDelta, udcDelta, uacDelta, vdcDelta, vacDelta, qm, qmY, qmU, qmV },
        segmentation: { enabled, updateMap: enabled, data: segmentData, preskip, lastActiveSegId, qidx, lossless },
        allLossless,
        deltaQ: { present: deltaQPresent, resLog2: deltaQResLog2 },
        deltaLf: { present: deltaLfPresent, resLog2: deltaLfResLog2, multi: deltaLfMulti },
        loopFilter, cdef, restoration, txMode, reducedTxSet, filmGrain
    });
}

export const OBU_SEQUENCE_HEADER = 1, OBU_TEMPORAL_DELIMITER = 2, OBU_FRAME_HEADER = 3, OBU_TILE_GROUP = 4,
    OBU_METADATA = 5, OBU_FRAME = 6, OBU_REDUNDANT_FRAME_HEADER = 7, OBU_PADDING = 15;

export interface Obu {
    type: number;
    temporalId: number;
    spatialId: number;
    /** the payload's start and end in the data */
    start: number;
    end: number;
}

/** Splits low overhead bitstream format data (OBUs with sizes, as in AVIF and IVF) into its OBUs */
export function* obus(data: Uint8Array, start = 0, end = data.length): Generator<Obu> {
    let o = start;
    while (o < end) {
        const r = new BitReader(data, o, end);
        r.bit(); // forbidden
        const type = r.bits(4);
        const extension = r.bit(), hasSize = r.bit();
        r.bit();
        let temporalId = 0, spatialId = 0;
        if (extension) {
            temporalId = r.bits(3);
            spatialId = r.bits(2);
            r.bits(3);
        }
        const size = hasSize ? r.leb128() : end - r.byte;
        const payload = r.byte;
        if (payload + size > end) throw new Error('AV1: truncated OBU');
        yield { type, temporalId, spatialId, start: payload, end: payload + size };
        o = payload + size;
    }
}
