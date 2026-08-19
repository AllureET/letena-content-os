// Video Studio burned-in overlays (19 Aug 2026): title cards, on-screen
// labels, the closing door/CTA card, and icon moments, compiled
// deterministically into the final assembled cut. Split out of studio.mjs
// (already ~1200 lines before this) since this is a self-contained
// concern -- SVG compilation and ffmpeg filter-graph construction -- with
// its own set of pure, unit-testable functions, matching the same
// discipline studio.mjs's compileStillPrompt/compileMotionPrompt already
// apply: deterministic assembly from reviewed structured data, never a
// model freehanding the actual pixels.
//
// The real production brief this closes the gap for -- "Spotting on the
// Pill" (25s, talking-head presenter) -- needs a title card (0:00-0:02), a
// "share this" label (0:02-0:06), a clinical keyword label (0:11-0:15), a
// door/CTA card at the end (0:20-0:25) with four staggered fade-in lines,
// and icon overlays at a couple of moments, each with an exact hex colour,
// font, position, and timed animation. See 0035_studio_overlays.sql for
// the full schema reasoning; this file is what compiles studio.overlays
// rows into the actual burn-in.
//
// Technique: ffmpeg in this environment is built --enable-librsvg, so it
// decodes .svg files natively as an image/video input -- no node-canvas,
// no sharp, no new native dependency. Amharic (Ge'ez script) text is
// rendered by embedding Noto Sans Ethiopic directly in each generated SVG
// as a base64 @font-face data URL (apps/api/assets/fonts/
// NotoSansEthiopic-{Bold,Regular}.ttf, already instantiated as static
// weights in this repo), rather than relying on fontconfig having the
// font installed system-wide -- the embedded approach works identically
// wherever ffmpeg+librsvg exists, which Video Studio already requires, so
// it adds zero new deploy steps versus a font-provisioning step that would
// be easy to forget on a new box.
import { readFile } from 'node:fs/promises';

// ===========================================================================
// Constants shared by validation (studio.mjs's overlay routes) and
// compilation (this file).
// ===========================================================================
export const OVERLAY_KINDS = ['TITLE_CARD', 'LABEL', 'DOOR_CARD', 'ICON'];
export const ANCHORS = ['top', 'upper-third', 'top-right', 'right-center', 'center'];
export const ANIMATION_IN_TYPES = ['none', 'fade', 'slide-left', 'slide-right'];
export const ANIMATION_OUT_TYPES = ['none', 'fade'];
export const FONT_FAMILIES = ['bold', 'regular'];

// Every door-card line fades in at overlay.start_s + line.delay_s and fades
// out together with the rest of the card at the card's own end_s. The
// schema (0035) deliberately gives each line only a delay_s, not its own
// fade duration -- a card is one coherent design object, not four
// independently-timed ones -- so one fixed, documented duration is used
// for every line's in/out fade rather than inventing a per-line field the
// brief never asked for.
export const DOOR_CARD_LINE_FADE_S = 0.5;

function isHexColor(v) { return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v); }

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===========================================================================
// Validation (used by the POST/PATCH /studio/.../overlays routes). Returns
// an array of specific, human-readable problems -- empty means valid.
// Deliberately specific ("data.lines[2].text_color must be a #rrggbb hex
// color", not "invalid data") so a 422 tells a non-developer exactly what
// to fix, same standard the rest of this codebase holds itself to.
// ===========================================================================
function validatePosition(pos, path, errors) {
  if (pos == null || typeof pos !== 'object') { errors.push(`${path} is required`); return; }
  if (!ANCHORS.includes(pos.anchor)) errors.push(`${path}.anchor must be one of ${ANCHORS.join(', ')}`);
  if (pos.inset_px != null && typeof pos.inset_px !== 'number') errors.push(`${path}.inset_px must be a number`);
}

function validateAnimation(anim, path, allowedTypes, errors) {
  if (anim == null) return; // optional; a sensible default (none/no motion) applies at render time
  if (typeof anim !== 'object') { errors.push(`${path} must be an object`); return; }
  if (!allowedTypes.includes(anim.type)) errors.push(`${path}.type must be one of ${allowedTypes.join(', ')}`);
  if (anim.duration_s != null && (typeof anim.duration_s !== 'number' || anim.duration_s < 0)) {
    errors.push(`${path}.duration_s must be a non-negative number`);
  }
}

export function validateOverlayData(kind, data) {
  const errors = [];
  const d = data ?? {};
  if (kind === 'TITLE_CARD' || kind === 'LABEL') {
    if (!d.text || !String(d.text).trim()) errors.push('data.text is required');
    if (d.font_family != null && !FONT_FAMILIES.includes(d.font_family)) {
      errors.push(`data.font_family must be one of ${FONT_FAMILIES.join(', ')}`);
    }
    if (d.font_size_px != null && typeof d.font_size_px !== 'number') errors.push('data.font_size_px must be a number');
    if (d.text_color != null && !isHexColor(d.text_color)) errors.push('data.text_color must be a #rrggbb hex color');
    if (d.background_color != null && !isHexColor(d.background_color)) errors.push('data.background_color must be a #rrggbb hex color');
    if (d.background_opacity != null && (typeof d.background_opacity !== 'number' || d.background_opacity < 0 || d.background_opacity > 1)) {
      errors.push('data.background_opacity must be a number between 0 and 1');
    }
    if (d.corner_radius_px != null && typeof d.corner_radius_px !== 'number') errors.push('data.corner_radius_px must be a number');
    validatePosition(d.position, 'data.position', errors);
    validateAnimation(d.animation_in, 'data.animation_in', ANIMATION_IN_TYPES, errors);
    validateAnimation(d.animation_out, 'data.animation_out', ANIMATION_OUT_TYPES, errors);
  } else if (kind === 'DOOR_CARD') {
    if (d.background_color != null && !isHexColor(d.background_color)) errors.push('data.background_color must be a #rrggbb hex color');
    if (!Array.isArray(d.lines) || !d.lines.length) {
      errors.push('data.lines must be a non-empty array');
    } else {
      d.lines.forEach((l, i) => {
        if (!l || typeof l !== 'object') { errors.push(`data.lines[${i}] must be an object`); return; }
        if (!l.text || !String(l.text).trim()) errors.push(`data.lines[${i}].text is required`);
        if (l.font_family != null && !FONT_FAMILIES.includes(l.font_family)) {
          errors.push(`data.lines[${i}].font_family must be one of ${FONT_FAMILIES.join(', ')}`);
        }
        if (l.font_size_px != null && typeof l.font_size_px !== 'number') errors.push(`data.lines[${i}].font_size_px must be a number`);
        if (l.text_color != null && !isHexColor(l.text_color)) errors.push(`data.lines[${i}].text_color must be a #rrggbb hex color`);
        if (l.delay_s != null && (typeof l.delay_s !== 'number' || l.delay_s < 0)) errors.push(`data.lines[${i}].delay_s must be a non-negative number`);
      });
    }
  } else if (kind === 'ICON') {
    if (!d.asset_id || typeof d.asset_id !== 'string') errors.push('data.asset_id is required');
    if (d.width_px != null && typeof d.width_px !== 'number') errors.push('data.width_px must be a number');
    validatePosition(d.position, 'data.position', errors);
    validateAnimation(d.animation_in, 'data.animation_in', ANIMATION_IN_TYPES, errors);
    validateAnimation(d.animation_out, 'data.animation_out', ANIMATION_OUT_TYPES, errors);
  } else {
    errors.push(`kind must be one of ${OVERLAY_KINDS.join(', ')}`);
  }
  return errors;
}

// A real authoring mistake, not a hypothetical: two full cards fighting for
// the same screen real estate at overlapping times. Scoped to TITLE_CARD
// and DOOR_CARD only (per the task's own instruction) -- LABEL and ICON
// are small enough, and legitimately co-exist often enough (a corner label
// alongside an icon), that flagging every overlap there would be more
// noise than help. A DOOR_CARD has no position field (it is always
// full-screen -- see 0035's schema comment), so it is treated as its own
// anchor bucket ('full-screen') that only ever collides with another
// DOOR_CARD, never with a positioned TITLE_CARD.
export function describeOverlayCollision(existingOverlays, incomingKind, incomingData, incomingStartS, incomingEndS) {
  if (!['TITLE_CARD', 'DOOR_CARD'].includes(incomingKind)) return null;
  const incomingAnchor = incomingKind === 'DOOR_CARD' ? 'full-screen' : (incomingData?.position?.anchor ?? null);
  for (const ov of existingOverlays) {
    if (!['TITLE_CARD', 'DOOR_CARD'].includes(ov.kind)) continue;
    const ovAnchor = ov.kind === 'DOOR_CARD' ? 'full-screen' : (ov.data?.position?.anchor ?? null);
    if (ovAnchor !== incomingAnchor) continue;
    const overlap = Number(incomingStartS) < Number(ov.end_s) && Number(incomingEndS) > Number(ov.start_s);
    if (overlap) {
      return `overlaps with existing ${ov.kind} ${ov.id} (${ov.start_s}s-${ov.end_s}s) at the same screen position ("${ovAnchor}") -- pick a different anchor or a non-overlapping time range`;
    }
  }
  return null;
}

// ===========================================================================
// SVG compilation (pure, no ffmpeg needed -- see test/studio_overlays.test.mjs).
// ===========================================================================
function fontFaceDefs(boldB64, regB64) {
  return `<defs><style>
@font-face { font-family: 'EthiopicBold'; src: url("data:font/ttf;base64,${boldB64 ?? ''}") format('truetype'); }
@font-face { font-family: 'EthiopicRegular'; src: url("data:font/ttf;base64,${regB64 ?? ''}") format('truetype'); }
</style></defs>`;
}

function fontFamilyName(dataFontFamily) {
  return dataFontFamily === 'regular' ? 'EthiopicRegular' : 'EthiopicBold';
}

// No real text-shaping engine available at compile time (that is librsvg's
// job once ffmpeg actually rasterizes), so box width is estimated from
// character count -- generous enough for Ethiopic glyphs, which tend to be
// wider than Latin ones. Good enough for sizing a background box; it is
// never used for anything pixel-critical.
function estimateTextWidthPx(text, fontSizePx) {
  return Math.max(1, String(text ?? '').length) * Number(fontSizePx ?? 28) * 0.62;
}

function resolveAnchorXY(anchor, insetPx, boxW, boxH, canvasW, canvasH) {
  const inset = Number(insetPx ?? 24);
  switch (anchor) {
    case 'top': return { x: (canvasW - boxW) / 2, y: inset };
    case 'upper-third': return { x: (canvasW - boxW) / 2, y: canvasH / 3 - boxH / 2 };
    case 'top-right': return { x: canvasW - boxW - inset, y: inset };
    case 'right-center': return { x: canvasW - boxW - inset, y: (canvasH - boxH) / 2 };
    case 'center': return { x: (canvasW - boxW) / 2, y: (canvasH - boxH) / 2 };
    default: return { x: (canvasW - boxW) / 2, y: inset };
  }
}

// TITLE_CARD and LABEL share this compiler: a rounded box with centered
// text, positioned per data.position.anchor. Sized to the video's full
// canvas (not just the box) so the box's screen position is baked into a
// fixed spot within the image -- buildOverlayFilterGraph then animates the
// WHOLE image (fade alpha, or slide the whole frame in from off-canvas),
// which lands the box at exactly this resting position without the SVG
// itself needing to know about the animation.
function compileCardSvg(data, canvasW, canvasH, boldB64, regB64) {
  const d = data ?? {};
  const fontSize = Number(d.font_size_px ?? 28);
  const padX = Math.round(fontSize * 0.9);
  const padY = Math.round(fontSize * 0.55);
  const inset = Number(d.position?.inset_px ?? 24);
  const textW = estimateTextWidthPx(d.text, fontSize);
  const boxW = Math.max(1, Math.min(canvasW - 2 * inset, Math.round(textW + padX * 2)));
  const boxH = Math.round(fontSize + padY * 2);
  const { x, y } = resolveAnchorXY(d.position?.anchor ?? 'top', inset, boxW, boxH, canvasW, canvasH);
  const rx = Number(d.corner_radius_px ?? 12);
  const bgOpacity = d.background_opacity ?? 1;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">
${fontFaceDefs(boldB64, regB64)}
<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="${rx}" fill="${d.background_color ?? '#16103F'}" fill-opacity="${bgOpacity}"/>
<text x="${x + boxW / 2}" y="${y + boxH / 2 + fontSize * 0.34}" font-family="${fontFamilyName(d.font_family)}" font-size="${fontSize}" fill="${d.text_color ?? '#FFFFFF'}" text-anchor="middle">${escapeXml(d.text)}</text>
</svg>`;
}

// Stacked vertical Y positions (text baseline) for a door card's lines,
// centered as a group in the canvas. Shared by the "flat preview" compiler
// below and the per-line layer compiler in compileOverlayLayerSvg, so both
// always agree on exactly where each line sits.
function doorCardLineYPositions(lines, canvasH) {
  const heights = lines.map(l => Number(l.font_size_px ?? 28) * 1.6);
  const totalH = heights.reduce((a, b) => a + b, 0);
  let y = (canvasH - totalH) / 2;
  return lines.map((l, i) => {
    const h = heights[i];
    const cy = y + h / 2 + Number(l.font_size_px ?? 28) * 0.34;
    y += h;
    return cy;
  });
}

// The DOOR_CARD compiler used by compileOverlaySvg: one flat SVG with the
// full-screen background and every line drawn at full opacity. This is a
// faithful, deterministic single-image rendering of the card (useful for a
// preview, and exactly what the unit tests below assert against), but it
// is NOT what assemble() burns in for the real staggered fade-in -- that
// needs each line on its own ffmpeg input so each can fade in at its own
// delay_s (see planOverlayLayers/compileOverlayLayerSvg).
function compileDoorCardSvg(data, canvasW, canvasH, boldB64, regB64) {
  const d = data ?? {};
  const lines = Array.isArray(d.lines) ? d.lines : [];
  const ys = doorCardLineYPositions(lines, canvasH);
  const texts = lines.map((l, i) =>
    `<text x="${canvasW / 2}" y="${ys[i]}" font-family="${fontFamilyName(l.font_family)}" font-size="${Number(l.font_size_px ?? 28)}" fill="${l.text_color ?? '#FFFFFF'}" text-anchor="middle">${escapeXml(l.text)}</text>`
  ).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">
${fontFaceDefs(boldB64, regB64)}
<rect width="${canvasW}" height="${canvasH}" fill="${d.background_color ?? '#16103F'}"/>
${texts}
</svg>`;
}

function compileDoorCardBackgroundSvg(data, canvasW, canvasH) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">
<rect width="${canvasW}" height="${canvasH}" fill="${(data ?? {}).background_color ?? '#16103F'}"/>
</svg>`;
}

function compileDoorCardLineSvg(data, lineIndex, canvasW, canvasH, boldB64, regB64) {
  const lines = Array.isArray(data?.lines) ? data.lines : [];
  const line = lines[lineIndex] ?? {};
  const ys = doorCardLineYPositions(lines, canvasH);
  const cy = ys[lineIndex] ?? canvasH / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">
${fontFaceDefs(boldB64, regB64)}
<text x="${canvasW / 2}" y="${cy}" font-family="${fontFamilyName(line.font_family)}" font-size="${Number(line.font_size_px ?? 28)}" fill="${line.text_color ?? '#FFFFFF'}" text-anchor="middle">${escapeXml(line.text)}</text>
</svg>`;
}

// ICON: places a library icon (lcos.assets, kind='ICON') at a position,
// embedded as a base64 <image> the same way fonts are embedded -- so this
// SVG, like every other overlay SVG, is fully self-contained and needs no
// external file reachable at render time. iconBase64 is resolved by the
// caller (studio.mjs's assemble route, which already has the asset's
// storage_key) and passed in; compileOverlaySvg does not touch storage
// itself, keeping it a pure function of its arguments.
function compileIconSvg(data, canvasW, canvasH, iconBase64, iconMime = 'image/png') {
  const d = data ?? {};
  const widthPx = Number(d.width_px ?? 96);
  const heightPx = widthPx; // icons in the library are square; no separate height field in the schema
  const { x, y } = resolveAnchorXY(d.position?.anchor ?? 'top-right', d.position?.inset_px, widthPx, heightPx, canvasW, canvasH);
  const image = iconBase64
    ? `<image x="${x}" y="${y}" width="${widthPx}" height="${heightPx}" href="data:${iconMime};base64,${iconBase64}"/>`
    // No icon bytes resolved (e.g. compileOverlaySvg called for validation/
    // preview purposes without a storage lookup): emit nothing rather than
    // a fake placeholder box, so a caller that forgot to resolve the asset
    // gets an honestly-blank frame, not a lie about what will render.
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">${image}</svg>`;
}

// The single entry point for "give me the SVG for this overlay row",
// dispatching on kind. Pure and deterministic: same overlay + same canvas
// size + same font bytes always produces the same SVG string. For
// TITLE_CARD/LABEL/ICON this is exactly what assemble() burns in; for
// DOOR_CARD this is the flat preview (see compileDoorCardSvg above) --
// the real per-line-staggered burn-in goes through compileOverlayLayerSvg
// instead, driven by planOverlayLayers.
export function compileOverlaySvg(overlay, canvasWidth, canvasHeight, ethiopicFontBase64Bold, ethiopicFontBase64Regular, iconBase64Png) {
  const kind = overlay.kind;
  const data = overlay.data ?? {};
  if (kind === 'TITLE_CARD' || kind === 'LABEL') {
    return compileCardSvg(data, canvasWidth, canvasHeight, ethiopicFontBase64Bold, ethiopicFontBase64Regular);
  }
  if (kind === 'DOOR_CARD') {
    return compileDoorCardSvg(data, canvasWidth, canvasHeight, ethiopicFontBase64Bold, ethiopicFontBase64Regular);
  }
  if (kind === 'ICON') {
    return compileIconSvg(data, canvasWidth, canvasHeight, iconBase64Png);
  }
  throw new Error(`compileOverlaySvg: unknown overlay kind '${kind}'`);
}

// ===========================================================================
// Layer planning + the ffmpeg filter graph. "Layer" = one ffmpeg input.
// Most overlay kinds are exactly one layer; DOOR_CARD expands into a
// full-screen background layer plus one layer per line, so each line can
// carry its own delay_s-driven fade-in independently -- a single flat
// raster cannot fade one sentence in before another.
// ===========================================================================

// Pure: given the project's approved overlays (already time-sorted by the
// caller), returns the ordered list of layers buildOverlayFilterGraph's
// ffmpeg inputs must match EXACTLY, in this order (input 0 is always the
// base video; layer i is input i+1). Exported so the assemble route can
// call it once, write one SVG file per layer via compileOverlayLayerSvg,
// and pass the SAME array into buildOverlayFilterGraph -- there is exactly
// one place that decides "how many inputs does this set of overlays need,
// and in what order," so the file list and the filter graph can never
// drift apart.
export function planOverlayLayers(overlays) {
  const layers = [];
  for (const ov of overlays) {
    const data = ov.data ?? {};
    const startS = Number(ov.start_s);
    const endS = Number(ov.end_s);
    if (ov.kind === 'DOOR_CARD') {
      layers.push({
        overlayId: ov.id, kind: ov.kind, role: 'background', startS, endS,
        animationIn: { type: 'fade', duration_s: DOOR_CARD_LINE_FADE_S },
        animationOut: { type: 'fade', duration_s: DOOR_CARD_LINE_FADE_S },
      });
      const lines = Array.isArray(data.lines) ? data.lines : [];
      lines.forEach((line, lineIndex) => {
        const delay = Number(line.delay_s ?? 0);
        layers.push({
          overlayId: ov.id, kind: ov.kind, role: 'line', lineIndex,
          startS: startS + delay, endS,
          animationIn: { type: 'fade', duration_s: DOOR_CARD_LINE_FADE_S },
          animationOut: { type: 'fade', duration_s: DOOR_CARD_LINE_FADE_S },
        });
      });
    } else {
      layers.push({
        overlayId: ov.id, kind: ov.kind, role: 'card', startS, endS,
        animationIn: data.animation_in ?? { type: 'none', duration_s: 0 },
        animationOut: data.animation_out ?? { type: 'none', duration_s: 0 },
      });
    }
  }
  return layers;
}

// Given one layer descriptor from planOverlayLayers plus its source
// overlay row, returns that layer's SVG content. For 'card' roles (every
// kind except a door card's background/line pieces) this is exactly
// compileOverlaySvg; for door-card background/line pieces it delegates to
// the dedicated sub-compilers above.
export function compileOverlayLayerSvg(layer, overlay, canvasWidth, canvasHeight, boldB64, regB64, iconBase64Png) {
  if (layer.role === 'background') return compileDoorCardBackgroundSvg(overlay.data, canvasWidth, canvasHeight);
  if (layer.role === 'line') return compileDoorCardLineSvg(overlay.data, layer.lineIndex, canvasWidth, canvasHeight, boldB64, regB64);
  return compileOverlaySvg(overlay, canvasWidth, canvasHeight, boldB64, regB64, iconBase64Png);
}

// x-position expression for ffmpeg's overlay filter. Every overlay SVG is
// sized to the FULL video canvas with its box already drawn at its final
// resting position within that image (see compileCardSvg), so "slide the
// box in" is done by sliding the WHOLE image in from off-canvas: at
// t=start_s the image sits fully off to one side (x=+/-canvasWidth), and
// by t=start_s+duration it has reached x=0, its true resting position, and
// stays there. There is no vertical slide in the schema (animation_in.type
// has no 'slide-up'/'slide-down'), so y is always 0.
function xExprFor(layer, canvasWidth) {
  const type = layer.animationIn?.type;
  const dur = Number(layer.animationIn?.duration_s ?? 0);
  if ((type === 'slide-left' || type === 'slide-right') && dur > 0) {
    const s = layer.startS, e = s + dur;
    const sign = type === 'slide-left' ? '' : '-';
    return `if(lt(t,${e.toFixed(3)}),${sign}(${canvasWidth}*(${e.toFixed(3)}-t)/${dur.toFixed(3)}),0)`;
  }
  return '0';
}

// The alpha-fade portion of a layer's filter chain (format=rgba is always
// applied first so the fade filter has an alpha channel to operate on --
// librsvg's decoded frames carry one, but ffmpeg does not guarantee the
// filtergraph keeps it without an explicit format request). 'fade' is the
// only animation type that uses alpha; slide types move via x instead and
// apply no alpha ramp (they are visible the instant they arrive), by
// design -- see xExprFor above.
function fadeChainFor(layer) {
  const parts = ['format=rgba'];
  const dIn = layer.animationIn?.type === 'fade' && Number(layer.animationIn?.duration_s) > 0
    ? Number(layer.animationIn.duration_s) : 0;
  if (dIn > 0) parts.push(`fade=t=in:st=${layer.startS.toFixed(3)}:d=${dIn.toFixed(3)}:alpha=1`);
  const dOut = layer.animationOut?.type === 'fade' && Number(layer.animationOut?.duration_s) > 0
    ? Number(layer.animationOut.duration_s) : 0;
  if (dOut > 0) {
    const outStart = Math.max(layer.startS, layer.endS - dOut);
    parts.push(`fade=t=out:st=${outStart.toFixed(3)}:d=${dOut.toFixed(3)}:alpha=1`);
  }
  return parts.join(',');
}

// Builds the filter_complex fragment that composites every overlay layer
// onto the base video (input 0), in the same "return the fragment, let the
// caller supply -i args and run ffmpeg" convention buildCrossfadeVideoGraph/
// mixMusicOntoVideo already use in studio.mjs. Assumes the caller supplies
// exactly one ffmpeg input per entry in the returned `layers` array
// (planOverlayLayers' output), in that same order, immediately after the
// base video input -- i.e. layer i is ffmpeg input i+1. Layers that would
// start at or after the base video's own duration are dropped (they could
// never be visible and would give ffmpeg a zero/negative -t), same "don't
// silently generate garbage" instinct as the rest of this file.
export function buildOverlayFilterGraph(overlays, baseVideoDuration, canvasWidth, canvasHeight) {
  const duration = Number(baseVideoDuration ?? Infinity);
  const layers = planOverlayLayers(overlays)
    .filter(l => l.startS < duration)
    .map(l => ({ ...l, endS: Math.min(l.endS, duration) }));

  if (!layers.length) return { filterComplex: '', outputLabel: '[0:v]', layers: [] };

  const filters = [];
  layers.forEach((layer, i) => {
    const inputIdx = i + 1;
    filters.push(`[${inputIdx}:v]${fadeChainFor(layer)}[ov${i}]`);
  });
  let prevLabel = '[0:v]';
  layers.forEach((layer, i) => {
    const outLabel = i === layers.length - 1 ? '[vout]' : `[vtmp${i}]`;
    const xExpr = xExprFor(layer, canvasWidth);
    filters.push(`${prevLabel}[ov${i}]overlay=x='${xExpr}':y=0:enable='between(t,${layer.startS.toFixed(3)},${layer.endS.toFixed(3)})'${outLabel}`);
    prevLabel = outLabel;
  });
  return { filterComplex: filters.join(';'), outputLabel: '[vout]', layers };
}

// A sensible canvas pixel size for a project's aspect_ratio when there is
// no real video file to probe yet (MOCK mode has none -- see the assemble
// route). Not used when a real base video exists; the real path probes the
// actual assembled file's width/height instead, since the overlay SVGs
// must match the real frame size exactly for full-canvas compositing to
// land the box in the right place.
export function resolveCanvasSizeForAspect(aspectRatio) {
  const [wRatio, hRatio] = String(aspectRatio ?? '9:16').split(':').map(Number);
  if (!wRatio || !hRatio) return { width: 1080, height: 1920 };
  const base = 1920;
  return hRatio >= wRatio
    ? { width: Math.round(base * wRatio / hRatio), height: base }
    : { width: base, height: Math.round(base * hRatio / wRatio) };
}

// ===========================================================================
// Font loading. Reads the two static Ethiopic weights once and caches the
// base64 in memory (module-level -- these files never change at runtime),
// so repeated assemble() calls don't re-read and re-encode a ~360KB font
// file on every request.
// ===========================================================================
let _fontCache = null;
export async function loadEthiopicFontsBase64() {
  if (_fontCache) return _fontCache;
  const boldPath = new URL('../../assets/fonts/NotoSansEthiopic-Bold.ttf', import.meta.url);
  const regularPath = new URL('../../assets/fonts/NotoSansEthiopic-Regular.ttf', import.meta.url);
  const [bold, regular] = await Promise.all([
    readFile(boldPath).then(b => b.toString('base64')),
    readFile(regularPath).then(b => b.toString('base64')),
  ]);
  _fontCache = { bold, regular };
  return _fontCache;
}
