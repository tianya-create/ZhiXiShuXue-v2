<template>
  <div ref="containerRef" class="aurora-container"></div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'

const props = defineProps({
  colorStops: {
    type: Array,
    default: () => ['#5227FF', '#7cff67', '#5227FF']
  },
  amplitude: { type: Number, default: 1.0 },
  blend: { type: Number, default: 0.5 },
  speed: { type: Number, default: 1.0 }
})

const containerRef = ref(null)
let renderer = null
let program = null
let mesh = null
let animateId = null

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const FRAG = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uAmplitude;
uniform vec3 uColorStops[3];
uniform vec2 uResolution;
uniform float uBlend;

out vec4 fragColor;

vec3 permute(vec3 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

float snoise(vec2 v){
  const vec4 C = vec4(
      0.211324865405187, 0.366025403784439,
      -0.577350269189626, 0.024390243902439
  );
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);

  vec3 p = permute(
      permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0)
  );

  vec3 m = max(
      0.5 - vec3(
          dot(x0, x0),
          dot(x12.xy, x12.xy),
          dot(x12.zw, x12.zw)
      ),
      0.0
  );
  m = m * m;
  m = m * m;

  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);

  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

struct ColorStop {
  vec3 color;
  float position;
};

#define COLOR_RAMP(colors, factor, finalColor) {              \
  int index = 0;                                            \
  for (int i = 0; i < 2; i++) {                               \
     ColorStop currentColor = colors[i];                    \
     bool isInBetween = currentColor.position <= factor;    \
     index = int(mix(float(index), float(i), float(isInBetween))); \
  }                                                         \
  ColorStop currentColor = colors[index];                   \
  ColorStop nextColor = colors[index + 1];                  \
  float range = nextColor.position - currentColor.position; \
  float lerpFactor = (factor - currentColor.position) / range; \
  finalColor = mix(currentColor.color, nextColor.color, lerpFactor); \
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  ColorStop colors[3];
  colors[0] = ColorStop(uColorStops[0], 0.0);
  colors[1] = ColorStop(uColorStops[1], 0.5);
  colors[2] = ColorStop(uColorStops[2], 1.0);

  vec3 rampColor;
  COLOR_RAMP(colors, uv.x, rampColor);

  float height = snoise(vec2(uv.x * 2.0 + uTime * 0.1, uTime * 0.25)) * 0.5 * uAmplitude;
  height = exp(height);
  height = (uv.y * 2.0 - height + 0.2);
  float intensity = 0.6 * height;

  float midPoint = 0.20;
  float auroraAlpha = smoothstep(midPoint - uBlend * 0.5, midPoint + uBlend * 0.5, intensity);

  vec3 auroraColor = intensity * rampColor;

  fragColor = vec4(auroraColor * auroraAlpha, auroraAlpha);
}
`

function hexToRgb(hex) {
  let value = hex.replace('#', '')
  if (value.length === 3) {
    value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2]
  }
  const r = parseInt(value.slice(0, 2), 16) / 255
  const g = parseInt(value.slice(2, 4), 16) / 255
  const b = parseInt(value.slice(4, 6), 16) / 255
  return [r, g, b]
}

function initAurora() {
  const container = containerRef.value
  if (!container) return

  // Create WebGL context
  const canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.backgroundColor = 'transparent'
  container.appendChild(canvas)

  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true
  })

  if (!gl) {
    console.warn('WebGL2 not supported')
    return
  }

  gl.clearColor(0, 0, 0, 0)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

  // Create triangle geometry
  const positions = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  gl.enableVertexAttribArray(0)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  // Create shader program
  const vertShader = gl.createShader(gl.VERTEX_SHADER)
  gl.shaderSource(vertShader, VERT)
  gl.compileShader(vertShader)

  const fragShader = gl.createShader(gl.FRAGMENT_SHADER)
  gl.shaderSource(fragShader, FRAG)
  gl.compileShader(fragShader)

  program = gl.createProgram()
  gl.attachShader(program, vertShader)
  gl.attachShader(program, fragShader)
  gl.linkProgram(program)
  gl.useProgram(program)

  // Set uniforms
  const colorStopsArray = props.colorStops.map(hex => hexToRgb(hex))
  const uColorStops = []
  for (let i = 0; i < 3; i++) {
    uColorStops.push(gl.getUniformLocation(program, `uColorStops[${i}]`))
  }

  const uniforms = {
    uTime: gl.getUniformLocation(program, 'uTime'),
    uAmplitude: gl.getUniformLocation(program, 'uAmplitude'),
    uResolution: gl.getUniformLocation(program, 'uResolution'),
    uBlend: gl.getUniformLocation(program, 'uBlend')
  }

  function resize() {
    const width = container.clientWidth || 1
    const height = container.clientHeight || 1
    canvas.width = width
    canvas.height = height
    gl.viewport(0, 0, width, height)
    gl.uniform2f(uniforms.uResolution, width, height)
  }

  resize()
  window.addEventListener('resize', resize)

  let startTime = performance.now()

  function render() {
    const time = (performance.now() - startTime) * 0.001
    gl.uniform1f(uniforms.uTime, time * props.speed * 0.1)
    gl.uniform1f(uniforms.uAmplitude, props.amplitude)
    gl.uniform1f(uniforms.uBlend, props.blend)

    for (let i = 0; i < 3; i++) {
      gl.uniform3fv(uColorStops[i], colorStopsArray[i])
    }

    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    animateId = requestAnimationFrame(render)
  }

  animateId = requestAnimationFrame(render)

  // Cleanup function stored on container
  container._cleanup = () => {
    cancelAnimationFrame(animateId)
    window.removeEventListener('resize', resize)
    gl.deleteProgram(program)
    gl.deleteBuffer(buffer)
    gl.deleteVertexArray(vao)
    if (canvas.parentNode === container) {
      container.removeChild(canvas)
    }
  }
}

onMounted(() => {
  initAurora()
})

onBeforeUnmount(() => {
  const container = containerRef.value
  if (container && container._cleanup) {
    container._cleanup()
  }
})

watch([
  () => props.colorStops,
  () => props.amplitude,
  () => props.blend
], () => {
  // Colors will be updated in the render loop
}, { deep: true })
</script>

<style scoped>
.aurora-container {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
}
</style>
