const header = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outColor;
`;

export const fullscreenVertex = `#version 300 es
out vec2 uv;
void main() {
  uv = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Texture row zero represents the top of the video in every intermediate pass.
export const stabilizeMask = header + `
uniform sampler2D incoming;
uniform sampler2D previous;
uniform float historyWeight;

void main() {
  vec2 pixel = 0.68 / vec2(textureSize(incoming, 0));
  float next = texture(incoming, uv).r * 0.58;
  next += 0.105 * (texture(incoming, uv + vec2(pixel.x, 0.0)).r +
      texture(incoming, uv - vec2(pixel.x, 0.0)).r +
      texture(incoming, uv + vec2(0.0, pixel.y)).r +
      texture(incoming, uv - vec2(0.0, pixel.y)).r);
  float last = texture(previous, uv).r;
  // Follow a moving silhouette quickly and average small confidence fluctuations.
  float retention = historyWeight * (1.0 - 0.86 * smoothstep(0.12, 0.65, abs(next - last)));
  outColor = vec4(mix(next, last, retention), 0.0, 0.0, 1.0);
}
`;

const matte = `
uniform sampler2D mask;
uniform float hasMask;
uniform vec4 videoRect;
uniform float mirrored;

vec2 cameraUv(vec2 p) {
  vec2 q = (p - videoRect.xy) / videoRect.zw;
  q.x = mix(q.x, 1.0 - q.x, mirrored);
  return q;
}

bool inside(vec2 p) {
  return all(greaterThanEqual(p, vec2(0.0))) && all(lessThanEqual(p, vec2(1.0)));
}

float coverage(vec2 q) {
  if (hasMask < 0.5 || !inside(q)) return 0.0;
  return smoothstep(0.31, 0.68, texture(mask, q).r);
}
`;

export const captureEcho = header + matte + `
uniform sampler2D camera;

void main() {
  float alpha = coverage(uv);
  float light = dot(texture(camera, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
  outColor = vec4(light * alpha, 0.0, 0.0, alpha);
}
`;

export const drawEmission = header + matte + `
uniform sampler2D rearEffects;
uniform sampler2D compass;
uniform highp sampler2DArray echoes;
uniform vec4 echoFrames[4];
uniform vec2 aspect;
uniform vec2 floorAnchor;
uniform vec2 body;
uniform vec3 compassShape; // radius relative to short side, tilt, opacity
uniform vec2 timing; // time, intensity
uniform vec4 echoReveals;

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec4 h = fract(sin(vec4(dot(i, vec2(127.1, 311.7))) +
      vec4(0.0, 127.1, 311.7, 438.8)) * 43758.5453);
  return mix(mix(h.x, h.y, f.x), mix(h.z, h.w, f.x), f.y);
}

vec3 floorLight() {
  vec2 p = (uv - floorAnchor) * aspect / max(0.001, compassShape.x);
  // Inverse projection of a plane through the foot anchor. The near side opens toward the lens.
  float denominator = compassShape.y + 0.37 * p.y;
  if (denominator <= 0.02) return vec3(0.0);
  float z = p.y / denominator;
  vec2 plane = vec2(p.x * (1.0 - 0.37 * z), z);
  float radius = length(plane);
  if (radius > 1.32) return vec3(0.0);
  float turn = timing.x * 0.29;
  vec2 q = mat2(cos(turn), -sin(turn), sin(turn), cos(turn)) * plane;
  vec3 engraving = texture(compass, q * (310.0 / 800.0) + 0.5).rgb;
  float wash = max(0.0, 1.0 - radius) * (0.10 + 0.06 * exp(-radius * radius * 12.0));
  float sweep = pow(max(0.0, cos(atan(q.y, q.x) - timing.x * 1.8)), 16.0);
  return (engraving * (0.91 + sweep * 0.76) + vec3(0.03, 0.29, 0.88) * wash)
      * compassShape.z;
}

vec3 echoLight(vec2 q, float index, float distanceFromCenter, float reveal) {
  int i = int(index);
  vec4 trail = echoFrames[i];
  if (trail.w < 0.5 || reveal < 0.01) return vec3(0.0);
  float side = i < 2 ? -1.0 : 1.0;
  float scale = mix(0.93, 0.74, distanceFromCenter);
  float travel = mix(1.06, 1.98, distanceFromCenter);
  float space = min(compassShape.x * 0.50, 0.18);
  vec2 foot = floorAnchor + vec2(side * travel * space / aspect.x * reveal,
      -space * mix(0.18, 0.53, distanceFromCenter) / aspect.y);
  vec2 p = cameraUv((uv - foot) / scale + floorAnchor) + trail.xy;
  if (!inside(p) || abs(p.x - q.x) > 0.70) return vec3(0.0);
  vec4 echo = texture(echoes, vec3(p, trail.z));
  if (echo.a < 0.035) return vec3(0.0);
  vec2 stepSize = 1.8 / vec2(textureSize(echoes, 0).xy);
  float edge = max(0.0, echo.a - min(
      texture(echoes, vec3(p + vec2(side * stepSize.x, 0.0), trail.z)).a,
      texture(echoes, vec3(p + vec2(0.0, -stepSize.y), trail.z)).a));
  float light = echo.r / max(echo.a, 0.01);
  float veil = 0.82 + 0.18 * sin(uv.y * 165.0 + timing.x * 15.0 + index * 1.6);
  float filament = smoothstep(0.93, 1.0, sin(p.x * 162.0 + index * 4.0));
  vec3 hue = mix(vec3(0.03, 0.48, 0.72), vec3(0.16, 0.20, 0.70), distanceFromCenter);
  vec3 color = hue * (0.22 + light * 0.79 + filament * 0.11) * echo.a * veil;
  return (color + mix(hue, vec3(0.5, 0.9, 1.0), 0.55) * edge * 0.94)
      * mix(1.0, 0.72, distanceFromCenter) * reveal * timing.y;
}

vec3 auraLight(vec2 q, float silhouette) {
  if (hasMask < 0.5 || !inside(q) || timing.y < 0.02) return vec3(0.0);
  vec2 p = (uv - body) * aspect;
  float radius = max(0.13, compassShape.x * 0.71);
  if (abs(p.x) > radius * 1.15 || abs(p.y) > radius * 1.45) return vec3(0.0);
  vec2 flow = vec2(p.x * 22.0, p.y * 14.0 + timing.x * 1.65);
  float curl = noise(flow) * 0.62 + noise(flow * 2.07) * 0.38;
  float lift = 0.026 + curl * 0.12;
  vec2 drift = vec2((curl - 0.5) * 0.105, lift) / videoRect.zw / aspect;
  float wake = max(coverage(q + drift), coverage(q + drift * vec2(-0.6, 0.52)));
  wake *= (1.0 - silhouette) * (1.0 - smoothstep(0.24, 1.13, length(p / vec2(radius, radius * 1.5))));
  float ray = pow(0.5 + 0.5 * sin(flow.x * 1.8 + curl * 4.9), 5.0);
  return mix(vec3(0.06, 0.13, 0.69), vec3(0.08, 0.68, 1.5), ray)
      * wake * (0.07 + 0.44 * curl * curl) * timing.y;
}

void main() {
  vec2 q = cameraUv(uv);
  float silhouette = coverage(q);
  vec3 ghosts = vec3(0.0);
  if (silhouette < 0.99) {
    ghosts = echoLight(q, 0.0, 1.0, echoReveals.x) + echoLight(q, 3.0, 1.0, echoReveals.w)
      + echoLight(q, 1.0, 0.0, echoReveals.y) + echoLight(q, 2.0, 0.0, echoReveals.z);
  }
  vec3 back = texture(rearEffects, uv).rgb + floorLight() + auraLight(q, silhouette) + ghosts;
  outColor = vec4(back * (1.0 - silhouette), 1.0);
}
`;

export const blurEmission = header + `
uniform sampler2D lightPass;
uniform vec2 stepUv;

void main() {
  vec3 sum = texture(lightPass, uv).rgb * 0.227027;
  sum += (texture(lightPass, uv + stepUv * 1.384615).rgb +
      texture(lightPass, uv - stepUv * 1.384615).rgb) * 0.316216;
  sum += (texture(lightPass, uv + stepUv * 3.230769).rgb +
      texture(lightPass, uv - stepUv * 3.230769).rgb) * 0.070270;
  outColor = vec4(sum, 1.0);
}
`;

export const composite = header + matte + `
uniform sampler2D camera;
uniform sampler2D emission;
uniform sampler2D bloom;
uniform vec2 aspect;
uniform vec2 body;
uniform vec4 shock; // x, y, age fraction, strength
uniform float intensity;

vec3 feed(vec2 q) {
  return inside(q) ? texture(camera, q).rgb : vec3(0.012, 0.020, 0.035);
}

float edgeStrength(vec2 q) {
  vec2 d = 1.15 / vec2(textureSize(mask, 0));
  float a = coverage(q + vec2(-d.x, -d.y));
  float b = coverage(q + vec2(0.0, -d.y));
  float c = coverage(q + vec2(d.x, -d.y));
  float g = coverage(q + vec2(-d.x, d.y));
  float h = coverage(q + vec2(0.0, d.y));
  float i = coverage(q + vec2(d.x, d.y));
  vec2 gradient = vec2(c + 2.0 * coverage(q + vec2(d.x, 0.0)) + i
      - a - 2.0 * coverage(q - vec2(d.x, 0.0)) - g,
      g + 2.0 * h + i - a - 2.0 * b - c);
  return smoothstep(0.22, 3.45, length(gradient));
}

void main() {
  vec2 p = vec2(uv.x, 1.0 - uv.y);
  vec2 q = cameraUv(p);
  float subject = coverage(q);
  vec3 cameraColor = feed(q);
  vec2 delta = (p - shock.xy) * aspect;
  float distanceFromShock = length(delta);
  float waveRadius = 0.025 + shock.z * (0.45 + 0.42 * shock.w);
  float wave = (distanceFromShock - waveRadius) / (0.018 + 0.021 * shock.z);
  float amplitude = exp(-wave * wave) * (1.0 - shock.z) * shock.w;
  vec3 room = cameraColor;
  if (amplitude > 0.001 && subject < 0.99) {
    vec2 shift = delta / max(distanceFromShock, 0.001) / aspect / videoRect.zw;
    shift.x *= mix(1.0, -1.0, mirrored);
    shift *= sin(wave * 2.1) * 0.041 * amplitude;
    room = vec3(feed(q + shift * 0.55).r, feed(q + shift).g, feed(q + shift * 1.38).b);
  }

  float light = dot(room, vec3(0.2126, 0.7152, 0.0722));
  float vignette = 1.0 - 0.57 * smoothstep(0.13, 0.88, length((p - body) * aspect));
  vec3 grade = (mix(room, light * vec3(0.46, 0.57, 0.88), 0.64) * 0.58
      + vec3(0.025, 0.028, 0.09)) * vignette;
  room = mix(room, grade, intensity * 0.94);
  vec3 performer = cameraColor * mix(vec3(1.0), vec3(0.94, 0.98, 1.05), intensity);
  vec3 base = mix(room, performer, subject);
  float rim = 0.0;
  if (hasMask > 0.5 && inside(q) && subject > 0.015 && subject < 0.985) {
    rim = edgeStrength(q) * intensity;
  }
  vec3 radiance = texture(emission, p).rgb + texture(bloom, p).rgb * (0.70 - 0.54 * subject);
  radiance += vec3(0.18, 0.73, 1.26) * rim * 0.48;
  radiance += vec3(0.08, 0.37, 0.83) * amplitude * 0.29 * (1.0 - subject);
  // Filmic highlight roll-off leaves the base feed unchanged wherever there is no light.
  outColor = vec4(base + (1.0 - base) * (1.0 - exp(-2.05 * radiance)), 1.0);
}
`;
