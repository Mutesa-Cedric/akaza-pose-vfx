import { DrawingUtils, type MPMask } from '@mediapipe/tasks-vision';

const MASK_BACKGROUND = [0, 0, 0, 255] as [number, number, number, number];
const MASK_FOREGROUND = [255, 255, 255, 255] as [number, number, number, number];

/** Reads only the reduced confidence mask from MediaPipe's own GPU context. */
export class PoseMaskReader {
  private readonly drawing: DrawingUtils;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly texture: WebGLTexture;
  private width = 0;
  private height = 0;
  private rgba = new Uint8Array(0);

  constructor(readonly gl: WebGL2RenderingContext) {
    const framebuffer = gl.createFramebuffer();
    const texture = gl.createTexture();
    if (!framebuffer || !texture) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      throw new Error('Could not allocate the pose mask readback target');
    }
    this.framebuffer = framebuffer;
    this.texture = texture;
    this.drawing = new DrawingUtils(gl);
  }

  read(mask: MPMask, width: number, height: number, output: Uint8Array): void {
    const gl = this.gl;
    const readFramebuffer = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const drawFramebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const viewport = gl.getParameter(gl.VIEWPORT);
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    const vertexArray = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    const arrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    const packBuffer = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    const active = gl.getParameter(gl.ACTIVE_TEXTURE);
    const clearColor = gl.getParameter(gl.COLOR_CLEAR_VALUE);
    const boundTextures: (WebGLTexture | null)[] = [];
    for (let unit = 0; unit < 3; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      boundTextures.push(gl.getParameter(gl.TEXTURE_BINDING_2D));
    }

    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      if (this.width !== width || this.height !== height) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error('Pose mask readback framebuffer is incomplete');
        }
        this.width = width;
        this.height = height;
        this.rgba = new Uint8Array(width * height * 4);
      }
      gl.viewport(0, 0, width, height);
      this.drawing.drawConfidenceMask(mask, MASK_BACKGROUND, MASK_FOREGROUND);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      // Float-texture readPixels is driver-dependent. Convert to RGBA8 with a draw first.
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.rgba);
      for (let y = 0; y < height; y++) {
        const row = (height - 1 - y) * width;
        for (let x = 0; x < width; x++) {
          output[y * width + x] = this.rgba[(row + x) * 4];
        }
      }
    } finally {
      for (let unit = 0; unit < 3; unit++) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, boundTextures[unit]);
      }
      gl.activeTexture(active);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFramebuffer);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFramebuffer);
      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, arrayBuffer);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, packBuffer);
      gl.useProgram(program);
      gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
      gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
    }
  }

  dispose(): void {
    this.drawing.close();
    this.gl.deleteFramebuffer(this.framebuffer);
    this.gl.deleteTexture(this.texture);
  }
}
