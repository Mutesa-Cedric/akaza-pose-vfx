import type { MPMask } from '@mediapipe/tasks-vision';
import type { Vec2 } from '../cv/akazaPoseClassifier';
import { PoseMaskReader } from '../cv/poseMaskReader';
import { getCompassSprite } from './compassRenderer';
import type { VideoViewportRect } from './debugOverlayRenderer';
import {
  blurEmission,
  captureEcho,
  composite,
  drawEmission,
  fullscreenVertex,
  stabilizeMask,
} from './afterglowShaders';

const ECHO_COUNT = 8;
const ECHO_INTERVAL_SEC = 0.07;
const ECHO_DELAYS = [0.38, 0.14, 0.22, 0.47];
const MAX_MASK_SIZE = 448;
export const MAX_COMPOSITE_SIZE = 1440;
const MAX_REAR_SIZE = 960;

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

interface Pass<U extends string> {
  program: WebGLProgram;
  uniforms: Record<U, WebGLUniformLocation | null>;
}

export interface AfterglowScene {
  time: number;
  intensity: number;
  floor: Vec2;
  center: Vec2;
  compassRadius: number;
  compassOpacity: number;
  echoReveals: Float32Array;
  shockOrigin: Vec2;
  shockAge: number;
  shockStrength: number;
}

function requireResource<T>(resource: T | null, label: string): T {
  if (!resource) throw new Error(`Could not create WebGL ${label}`);
  return resource;
}

export class AfterglowCompositor {
  private readonly programs: WebGLProgram[] = [];
  private readonly textures: WebGLTexture[] = [];
  private readonly framebuffers: WebGLFramebuffer[] = [];
  private readonly rearCanvas = document.createElement('canvas');
  private readonly hdr: boolean;

  private readonly camera: WebGLTexture;
  private readonly compass: WebGLTexture;
  private readonly rear: WebGLTexture;
  private readonly rawMask: WebGLTexture;
  private readonly echoes: WebGLTexture;
  private readonly echoFramebuffer: WebGLFramebuffer;
  private readonly maskTargets: Target[];
  private readonly emission: Target;
  private readonly bloomX: Target;
  private readonly bloomY: Target;
  private readonly maskPass: Pass<'incoming' | 'previous' | 'historyWeight'>;
  private readonly capturePass: Pass<'mask' | 'hasMask' | 'camera'>;
  private readonly emissionPass: Pass<'mask' | 'hasMask' | 'videoRect' | 'mirrored' | 'rearEffects' |
    'compass' | 'echoes' | 'echoFrames[0]' | 'aspect' | 'floorAnchor' | 'body' | 'compassShape' | 'timing' | 'echoReveals'>;
  private readonly blurPass: Pass<'lightPass' | 'stepUv'>;
  private readonly compositePass: Pass<'mask' | 'hasMask' | 'videoRect' | 'mirrored' | 'camera' |
    'emission' | 'bloom' | 'aspect' | 'body' | 'shock' | 'intensity'>;

  private maskIndex = 0;
  private maskValid = false;
  private maskPixels = new Uint8Array(0);
  private maskVisited = new Uint8Array(0);
  private maskQueue = new Int32Array(0);
  private maskReader: PoseMaskReader | null = null;
  private lastVideoTime = -Infinity;
  private videoWidth = 0;
  private videoHeight = 0;
  private rearUploaded = false;
  private echoWidth = 0;
  private echoHeight = 0;
  private echoIndex = 0;
  private lastEchoTime = -Infinity;
  private readonly echoFrames = new Float32Array(4 * ECHO_DELAYS.length);
  private readonly history = Array.from({ length: ECHO_COUNT }, () => ({
    time: -Infinity,
    x: 0,
    y: 0,
  }));

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
  ) {
    this.hdr = Boolean(gl.getExtension('EXT_color_buffer_float'));
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    try {
      this.camera = this.texture();
      this.compass = this.texture();
      this.rear = this.texture();
      this.rawMask = this.texture();
      this.echoes = this.texture(this.gl.TEXTURE_2D_ARRAY);
      this.echoFramebuffer = this.framebuffer();
      this.maskTargets = [this.target(), this.target()];
      this.emission = this.target();
      this.bloomX = this.target();
      this.bloomY = this.target();

      this.maskPass = this.pass(stabilizeMask, ['incoming', 'previous', 'historyWeight']);
      this.capturePass = this.pass(captureEcho, ['mask', 'hasMask', 'camera']);
      this.emissionPass = this.pass(drawEmission, [
        'mask', 'hasMask', 'videoRect', 'mirrored', 'rearEffects', 'compass', 'echoes',
        'echoFrames[0]', 'aspect', 'floorAnchor', 'body', 'compassShape', 'timing', 'echoReveals',
      ]);
      this.blurPass = this.pass(blurEmission, ['lightPass', 'stepUv']);
      this.compositePass = this.pass(composite, [
        'mask', 'hasMask', 'videoRect', 'mirrored', 'camera', 'emission', 'bloom', 'aspect', 'body',
        'shock', 'intensity',
      ]);

      const compass = getCompassSprite();
      if (!compass) throw new Error('Could not create the compass texture');
      this.uploadCanvas(this.compass, compass, false);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  static create(canvas: HTMLCanvasElement): AfterglowCompositor | null {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (!gl || gl.isContextLost()) return null;
    return new AfterglowCompositor(canvas, gl);
  }

  get hasMask(): boolean {
    return this.maskValid;
  }

  reset(): void {
    this.maskValid = false;
    this.lastVideoTime = -Infinity;
    this.clearEchoHistory();
  }

  clearEchoHistory(): void {
    this.lastEchoTime = -Infinity;
    this.echoIndex = 0;
    for (const frame of this.history) frame.time = -Infinity;
  }

  dispose(): void {
    const gl = this.gl;
    this.maskReader?.dispose();
    for (const program of this.programs) gl.deleteProgram(program);
    for (const texture of this.textures) gl.deleteTexture(texture);
    for (const framebuffer of this.framebuffers) gl.deleteFramebuffer(framebuffer);
  }

  getRearContext(width: number, height: number): CanvasRenderingContext2D {
    const scale = Math.min(1, MAX_REAR_SIZE / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    if (this.rearCanvas.width !== targetWidth || this.rearCanvas.height !== targetHeight) {
      this.rearCanvas.width = targetWidth;
      this.rearCanvas.height = targetHeight;
      this.rearUploaded = false;
    }
    const ctx = requireResource(this.rearCanvas.getContext('2d'), 'rear canvas context');
    ctx.setTransform(targetWidth / width, 0, 0, targetHeight / height, 0, 0);
    return ctx;
  }

  /** Consume the borrowed MediaPipe mask synchronously, before its callback returns. */
  updateMask(mask: MPMask | undefined, torsoX = 0.5, torsoY = 0.5): void {
    if (!mask || this.gl.isContextLost()) {
      this.maskValid = false;
      return;
    }

    const gl = this.gl;
    const scale = Math.min(1, MAX_MASK_SIZE / Math.max(mask.width, mask.height));
    const width = Math.max(1, Math.round(mask.width * scale));
    const height = Math.max(1, Math.round(mask.height * scale));
    const resized = this.resizeTarget(this.maskTargets[0], width, height, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.resizeTarget(this.maskTargets[1], width, height, gl.R8, gl.RED, gl.UNSIGNED_BYTE);

    if (this.maskPixels.length !== width * height) {
      this.maskPixels = new Uint8Array(width * height);
      this.maskVisited = new Uint8Array(width * height);
      this.maskQueue = new Int32Array(width * height);
    }
    const pixels = this.maskPixels;
    if (mask.hasWebGLTexture() && !mask.hasFloat32Array() && !mask.hasUint8Array()) {
      const context = mask.canvas?.getContext('webgl2');
      if (!context) throw new Error('MediaPipe pose mask has no WebGL context');
      if (this.maskReader?.gl !== context) {
        this.maskReader?.dispose();
        this.maskReader = new PoseMaskReader(context);
      }
      this.maskReader.read(mask, width, height, pixels);
    } else {
      const source = mask.hasUint8Array() ? mask.getAsUint8Array() : mask.getAsFloat32Array();
      const multiplier = source instanceof Uint8Array ? 1 : 255;
      const stepX = mask.width / width;
      const stepY = mask.height / height;
      for (let y = 0; y < height; y++) {
        const row = Math.floor((y + 0.5) * stepY) * mask.width;
        for (let x = 0; x < width; x++) {
          pixels[y * width + x] = source[row + Math.floor((x + 0.5) * stepX)] * multiplier;
        }
      }
    }
    this.keepTrackedSubject(width, height, torsoX, torsoY);

    this.bind(0, this.rawMask);
    if (resized) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, pixels);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.UNSIGNED_BYTE, pixels);
    }
    const previous = this.maskTargets[this.maskIndex];
    this.maskIndex = 1 - this.maskIndex;
    const u = this.begin(this.maskPass, this.maskTargets[this.maskIndex]);
    this.sampler(u.incoming, 0, this.rawMask);
    this.sampler(u.previous, 1, previous.texture);
    gl.uniform1f(u.historyWeight, this.maskValid && !resized ? 0.62 : 0);
    this.draw();
    this.maskValid = true;
  }

  private keepTrackedSubject(width: number, height: number, torsoX: number, torsoY: number): void {
    const pixels = this.maskPixels;
    const seedX = Math.floor(torsoX * width);
    const seedY = Math.floor(torsoY * height);
    if (seedX < 0 || seedX >= width || seedY < 0 || seedY >= height) return;
    const seed = seedY * width + seedX;
    if (pixels[seed] < 157) return;

    // Flood the solid interior so a thin bridge of confidence cannot attach another person.
    const visited = this.maskVisited;
    const queue = this.maskQueue;
    visited.fill(0);
    visited[seed] = 1;
    queue[0] = seed;
    let end = 1;
    const enqueue = (index: number) => {
      if (visited[index] || pixels[index] < 96) return;
      const column = index % width;
      if ((column > 0 && pixels[index - 1] < 72) ||
          (column < width - 1 && pixels[index + 1] < 72) ||
          (index >= width && pixels[index - width] < 72) ||
          (index < pixels.length - width && pixels[index + width] < 72)) return;
      visited[index] = 1;
      queue[end++] = index;
    };
    for (let head = 0; head < end; head++) {
      const index = queue[head];
      const x = index % width;
      if (x > 0) enqueue(index - 1);
      if (x < width - 1) enqueue(index + 1);
      if (index >= width) enqueue(index - width);
      if (index < pixels.length - width) enqueue(index + width);
    }
    if (end < pixels.length * 0.005) return;
    // Restore the original edge values within two pixels of that interior.
    for (let head = 0; head < end; head++) {
      const index = queue[head];
      const x = index % width;
      const y = (index - x) / width;
      for (let dy = Math.max(-2, -y); dy <= Math.min(2, height - 1 - y); dy++) {
        const row = index + dy * width;
        const reach = Math.abs(dy) === 2 ? 1 : 2;
        for (let dx = Math.max(-reach, -x); dx <= Math.min(reach, width - 1 - x); dx++) {
          visited[row + dx] = 1;
        }
      }
    }
    for (let index = 0; index < pixels.length; index++) {
      if (!visited[index]) pixels[index] = 0;
    }
  }

  render(
    video: HTMLVideoElement,
    rect: VideoViewportRect,
    shakeX: number,
    shakeY: number,
    mirrored: boolean,
    scene: AfterglowScene,
    sourceFloor: Vec2,
    capture: boolean,
    depthMatteEnabled = true,
  ): boolean {
    const gl = this.gl;
    if (gl.isContextLost()) return false;
    this.resizeRenderTargets();

    const resizedVideo = this.videoWidth !== video.videoWidth || this.videoHeight !== video.videoHeight;
    if (this.lastVideoTime !== video.currentTime || resizedVideo) {
      this.bind(0, this.camera);
      if (resizedVideo) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
        this.videoWidth = video.videoWidth;
        this.videoHeight = video.videoHeight;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
      }
      this.lastVideoTime = video.currentTime;
    }
    const useMask = depthMatteEnabled && this.maskValid;
    if (capture && useMask && video.currentTime - this.lastEchoTime >= ECHO_INTERVAL_SEC) {
      this.capture(video.currentTime, sourceFloor);
    }
    this.resolveEchoes(video.currentTime, sourceFloor);

    this.uploadCanvas(this.rear, this.rearCanvas, this.rearUploaded);
    this.rearUploaded = true;

    const width = this.canvas.width;
    const height = this.canvas.height;
    const shortSide = Math.min(width, height);
    const aspectX = width / shortSide;
    const aspectY = height / shortSide;
    const mask = this.maskTargets[this.maskIndex].texture;
    const left = (rect.offsetX + shakeX) / width;
    const top = (rect.offsetY + shakeY) / height;
    const videoW = rect.drawWidth / width;
    const videoH = rect.drawHeight / height;
    const tilt = Math.max(0.17, Math.min(0.38, 0.07 + (1 - scene.floor.y) * 1.2));

    const rear = this.begin(this.emissionPass, this.emission);
    this.sampler(rear.mask, 0, mask);
    this.sampler(rear.rearEffects, 1, this.rear);
    this.sampler(rear.compass, 2, this.compass);
    this.sampler(rear.echoes, 3, this.echoes, gl.TEXTURE_2D_ARRAY);
    gl.uniform1f(rear.hasMask, Number(useMask));
    gl.uniform4f(rear.videoRect, left, top, videoW, videoH);
    gl.uniform1f(rear.mirrored, Number(mirrored));
    gl.uniform4fv(rear['echoFrames[0]'], this.echoFrames);
    gl.uniform2f(rear.aspect, aspectX, aspectY);
    gl.uniform2f(rear.floorAnchor, scene.floor.x, scene.floor.y);
    gl.uniform2f(rear.body, scene.center.x, scene.center.y);
    gl.uniform3f(rear.compassShape, scene.compassRadius, tilt, scene.compassOpacity);
    gl.uniform2f(rear.timing, scene.time, scene.intensity);
    gl.uniform4fv(rear.echoReveals, scene.echoReveals);
    this.draw();

    this.blur(this.emission.texture, this.bloomX, 1.65 / this.bloomX.width, 0);
    this.blur(this.bloomX.texture, this.bloomY, 0, 1.65 / this.bloomY.height);

    const final = this.begin(this.compositePass, null);
    this.sampler(final.mask, 0, mask);
    this.sampler(final.camera, 1, this.camera);
    this.sampler(final.emission, 2, this.emission.texture);
    this.sampler(final.bloom, 3, this.bloomY.texture);
    gl.uniform1f(final.hasMask, Number(useMask));
    gl.uniform4f(final.videoRect, left, top, videoW, videoH);
    gl.uniform1f(final.mirrored, Number(mirrored));
    gl.uniform2f(final.aspect, aspectX, aspectY);
    gl.uniform2f(final.body, scene.center.x, scene.center.y);
    gl.uniform4f(final.shock, scene.shockOrigin.x, scene.shockOrigin.y, scene.shockAge, scene.shockStrength);
    gl.uniform1f(final.intensity, scene.intensity);
    this.draw();
    return true;
  }

  private capture(time: number, anchor: Vec2): void {
    const gl = this.gl;
    const scale = Math.min(1, MAX_MASK_SIZE / Math.max(this.videoWidth, this.videoHeight));
    const width = Math.max(1, Math.round(this.videoWidth * scale));
    const height = Math.max(1, Math.round(this.videoHeight * scale));
    if (width !== this.echoWidth || height !== this.echoHeight) {
      this.bind(0, this.echoes, gl.TEXTURE_2D_ARRAY);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, width, height, ECHO_COUNT, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.echoWidth = width;
      this.echoHeight = height;
      this.clearEchoHistory();
    }
    const layer = this.echoIndex;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.echoFramebuffer);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.echoes, 0, layer);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.capturePass.program);
    const u = this.capturePass.uniforms;
    this.sampler(u.mask, 0, this.maskTargets[this.maskIndex].texture);
    this.sampler(u.camera, 1, this.camera);
    gl.uniform1f(u.hasMask, 1);
    this.draw();

    this.history[layer].time = time;
    this.history[layer].x = anchor.x;
    this.history[layer].y = anchor.y;
    this.lastEchoTime = time;
    this.echoIndex = (layer + 1) % ECHO_COUNT;
  }

  private resolveEchoes(time: number, anchor: Vec2): void {
    for (let i = 0; i < ECHO_DELAYS.length; i++) {
      let index = -1;
      let nearest = Infinity;
      const desired = time - ECHO_DELAYS[i];
      for (let layer = 0; layer < ECHO_COUNT; layer++) {
        const distance = Math.abs(this.history[layer].time - desired);
        if (distance < nearest) {
          nearest = distance;
          index = layer;
        }
      }
      const frame = index < 0 ? null : this.history[index];
      const offset = i * 4;
      this.echoFrames[offset] = frame ? frame.x - anchor.x : 0;
      this.echoFrames[offset + 1] = frame ? frame.y - anchor.y : 0;
      this.echoFrames[offset + 2] = index;
      this.echoFrames[offset + 3] = Number(Boolean(frame));
    }
  }

  private blur(texture: WebGLTexture, target: Target, x: number, y: number): void {
    const u = this.begin(this.blurPass, target);
    this.sampler(u.lightPass, 0, texture);
    this.gl.uniform2f(u.stepUv, x, y);
    this.draw();
  }

  private resizeRenderTargets(): void {
    const gl = this.gl;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const format = this.hdr ? gl.RGBA16F : gl.RGBA8;
    const type = this.hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    this.resizeTarget(this.emission, width, height, format, gl.RGBA, type);
    const bw = Math.max(1, Math.round(width / 4));
    const bh = Math.max(1, Math.round(height / 4));
    this.resizeTarget(this.bloomX, bw, bh, format, gl.RGBA, type);
    this.resizeTarget(this.bloomY, bw, bh, format, gl.RGBA, type);
  }

  private uploadCanvas(texture: WebGLTexture, canvas: HTMLCanvasElement, allocated: boolean): void {
    const gl = this.gl;
    this.bind(0, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (allocated) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  private target(): Target {
    return { texture: this.texture(), framebuffer: this.framebuffer(), width: 0, height: 0 };
  }

  private resizeTarget(target: Target, width: number, height: number, internal: number, format: number, type: number): boolean {
    if (target.width === width && target.height === height) return false;
    const gl = this.gl;
    this.bind(0, target.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Afterglow framebuffer is incomplete');
    }
    target.width = width;
    target.height = height;
    return true;
  }

  private texture(target = this.gl.TEXTURE_2D as number): WebGLTexture {
    const gl = this.gl;
    const texture = requireResource(gl.createTexture(), 'texture');
    this.textures.push(texture);
    this.bind(0, texture, target);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Initialize even optional samplers so WebGL can validate the first draw.
    if (target === gl.TEXTURE_2D_ARRAY) {
      gl.texImage3D(target, 0, gl.RGBA8, 1, 1, ECHO_COUNT, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    } else {
      gl.texImage2D(target, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    return texture;
  }

  private framebuffer(): WebGLFramebuffer {
    const framebuffer = requireResource(this.gl.createFramebuffer(), 'framebuffer');
    this.framebuffers.push(framebuffer);
    return framebuffer;
  }

  private pass<U extends string>(source: string, uniforms: readonly U[]): Pass<U> {
    const gl = this.gl;
    const program = requireResource(gl.createProgram(), 'program');
    this.programs.push(program);
    for (const [kind, code] of [[gl.VERTEX_SHADER, fullscreenVertex], [gl.FRAGMENT_SHADER, source]] as const) {
      const shader = requireResource(gl.createShader(kind), 'shader');
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Afterglow shader compilation failed: ${message}`);
      }
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Afterglow shader link failed: ${gl.getProgramInfoLog(program)}`);
    }
    return {
      program,
      uniforms: Object.fromEntries(uniforms.map((name) => [name, gl.getUniformLocation(program, name)])) as Pass<U>['uniforms'],
    };
  }

  private begin<U extends string>(pass: Pass<U>, target: Target | null): Pass<U>['uniforms'] {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
    gl.viewport(0, 0, target?.width ?? this.canvas.width, target?.height ?? this.canvas.height);
    gl.useProgram(pass.program);
    return pass.uniforms;
  }

  private bind(unit: number, texture: WebGLTexture, target = this.gl.TEXTURE_2D as number): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(target, texture);
  }

  private sampler(location: WebGLUniformLocation | null, unit: number, texture: WebGLTexture, target?: number): void {
    this.bind(unit, texture, target);
    this.gl.uniform1i(location, unit);
  }

  private draw(): void {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }
}
