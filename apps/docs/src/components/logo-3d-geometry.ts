// Logo proportions (viewBox units): hexagon radius 40, circle radius 15, stroke 6.
// A unit cube corner projects to sqrt(8/3) from the centre when viewed down its diagonal.
export const HEX_RADIUS = Math.sqrt(8 / 3);
export const STROKE = (3 / 40) * HEX_RADIUS;
export const RING = (15 / 40) * HEX_RADIUS;
// Half the visible area: room for a corner pointing straight at the viewer mid-turn.
export const EXTENT = Math.sqrt(3) + STROKE + 0.05;
