<template>
  <div ref="containerRef" class="floating-lines-container"></div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import * as THREE from 'three'

const props = defineProps({
  linesGradient: {
    type: Array,
    default: () => ['#6366F1', '#8B5CF6', '#EC4899', '#F59E0B']
  },
  enabledWaves: {
    type: Array,
    default: () => ['top', 'middle', 'bottom']
  },
  lineCount: {
    type: [Number, Array],
    default: () => [6]
  },
  lineDistance: {
    type: [Number, Array],
    default: () => [5]
  },
  topWavePosition: {
    type: Object,
    default: () => ({ x: 10.0, y: 0.5, rotate: -0.4 })
  },
  middleWavePosition: {
    type: Object,
    default: () => ({ x: 5.0, y: 0.0, rotate: 0.2 })
  },
  bottomWavePosition: {
    type: Object,
    default: () => ({ x: 2.0, y: -0.7, rotate: 0.4 })
  },
  animationSpeed: { type: Number, default: 1 },
  interactive: { type: Boolean, default: true },
  bendRadius: { type: Number, default: 5.0 },
  bendStrength: { type: Number, default: -0.5 },
  mouseDamping: { type: Number, default: 0.05 },
  parallax: { type: Boolean, default: true },
  parallaxStrength: { type: Number, default: 0.2 }
})

const containerRef = ref(null)
let renderer = null
let material = null
let animationId = null
let clock = null
let resizeObserver = null

const targetMouse = new THREE.Vector2(-1000, -1000)
const currentMouse = new THREE.Vector2(-1000, -1000)
const targetInfluence = ref(0)
const currentInfluence = ref(0)
const targetParallax = new THREE.Vector2(0, 0)
const currentParallax = new THREE.Vector2(0, 0)

const MAX_GRADIENT_STOPS = 8

const vertexShader = `
precision highp float;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const fragmentShader = `
precision highp float;

uniform float iTime;
uniform vec3  iResolution;
uniform float animationSpeed;

uniform bool enableTop;
uniform bool enableMiddle;
uniform bool enableBottom;

uniform int topLineCount;
uniform int middleLineCount;
uniform int bottomLineCount;

uniform float topLineDistance;
uniform float middleLineDistance;
uniform float bottomLineDistance;

uniform vec3 topWavePosition;
uniform vec3 middleWavePosition;
uniform vec3 bottomWavePosition;

uniform vec2 iMouse;
uniform bool interactive;
uniform float bendRadius;
uniform float bendStrength;
uniform float bendInfluence;

uniform bool parallax;
uniform float parallaxStrength;
uniform vec2 parallaxOffset;

uniform vec3 lineGradient[8];
uniform int lineGradientCount;

const vec3 BLACK = vec3(0.0);
const vec3 PINK  = vec3(233.0, 71.0, 245.0) / 255.0;
const vec3 BLUE  = vec3(47.0,  75.0, 162.0) / 255.0;

mat2 rotate(float r) {
  return mat2(cos(r), sin(r), -sin(r), cos(r));
}

vec3 background_color(vec2 uv) {
  vec3 col = vec3(0.0);

  float y = sin(uv.x - 0.2) * 0.3 - 0.1;
  float m = uv.y - y;

  col += mix(BLUE, BLACK, smoothstep(0.0, 1.0, abs(m)));
  col += mix(PINK, BLACK, smoothstep(0.0, 1.0, abs(m - 0.8)));
  return col * 0.5;
}

vec3 getLineColor(float t, vec3 baseColor) {
  if (lineGradientCount <= 0) {
    return baseColor;
  }

  vec3 gradientColor;

  if (lineGradientCount == 1) {
    gradientColor = lineGradient[0];
  } else {
    float clampedT = clamp(t, 0.0, 0.9999);
    float scaled = clampedT * float(lineGradientCount - 1);
    int idx = int(floor(scaled));
    float f = fract(scaled);
    int idx2 = min(idx + 1, lineGradientCount - 1);

    vec3 c1 = lineGradient[idx];
    vec3 c2 = lineGradient[idx2];

    gradientColor = mix(c1, c2, f);
  }

  return gradientColor * 0.5;
}

float wave(vec2 uv, float offset, vec2 screenUv, vec2 mouseUv, bool shouldBend) {
  float time = iTime * animationSpeed;

  float x_offset   = offset;
  float x_movement = time * 0.1;
  float amp        = sin(offset + time * 0.2) * 0.3;
  float y          = sin(uv.x + x_offset + x_movement) * amp;

  if (shouldBend) {
    vec2 d = screenUv - mouseUv;
    float influence = exp(-dot(d, d) * bendRadius);
    float bendOffset = (mouseUv.y - screenUv.y) * influence * bendStrength * bendInfluence;
    y += bendOffset;
  }

  float m = uv.y - y;
  return 0.0175 / max(abs(m) + 0.01, 1e-3) + 0.01;
}

void main() {
  vec2 baseUv = (2.0 * gl_FragCoord.xy - iResolution.xy) / iResolution.y;
  baseUv.y *= -1.0;

  if (parallax) {
    baseUv += parallaxOffset;
  }

  vec3 col = vec3(0.0);

  vec3 b = lineGradientCount > 0 ? vec3(0.0) : background_color(baseUv);

  vec2 mouseUv = vec2(0.0);
  if (interactive) {
    mouseUv = (2.0 * iMouse - iResolution.xy) / iResolution.y;
    mouseUv.y *= -1.0;
  }

  if (enableBottom) {
    for (int i = 0; i < bottomLineCount; ++i) {
      float fi = float(i);
      float t = fi / max(float(bottomLineCount - 1), 1.0);
      vec3 lineCol = getLineColor(t, b);

      float angle = bottomWavePosition.z * log(length(baseUv) + 1.0);
      vec2 ruv = baseUv * rotate(angle);
      col += lineCol * wave(
        ruv + vec2(bottomLineDistance * fi + bottomWavePosition.x, bottomWavePosition.y),
        1.5 + 0.2 * fi,
        baseUv,
        mouseUv,
        interactive
      ) * 0.2;
    }
  }

  if (enableMiddle) {
    for (int i = 0; i < middleLineCount; ++i) {
      float fi = float(i);
      float t = fi / max(float(middleLineCount - 1), 1.0);
      vec3 lineCol = getLineColor(t, b);

      float angle = middleWavePosition.z * log(length(baseUv) + 1.0);
      vec2 ruv = baseUv * rotate(angle);
      col += lineCol * wave(
        ruv + vec2(middleLineDistance * fi + middleWavePosition.x, middleWavePosition.y),
        2.0 + 0.15 * fi,
        baseUv,
        mouseUv,
        interactive
      );
    }
  }

  if (enableTop) {
    for (int i = 0; i < topLineCount; ++i) {
      float fi = float(i);
      float t = fi / max(float(topLineCount - 1), 1.0);
      vec3 lineCol = getLineColor(t, b);

      float angle = topWavePosition.z * log(length(baseUv) + 1.0);
      vec2 ruv = baseUv * rotate(angle);
      ruv.x *= -1.0;
      col += lineCol * wave(
        ruv + vec2(topLineDistance * fi + topWavePosition.x, topWavePosition.y),
        1.0 + 0.2 * fi,
        baseUv,
        mouseUv,
        interactive
      ) * 0.1;
    }
  }

  gl_FragColor = vec4(col, 1.0);
}
`

function hexToVec3(hex) {
  let value = hex.trim()
  if (value.startsWith('#')) value = value.slice(1)

  let r = 255, g = 255, b = 255

  if (value.length === 3) {
    r = parseInt(value[0] + value[0], 16)
    g = parseInt(value[1] + value[1], 16)
    b = parseInt(value[2] + value[2], 16)
  } else if (value.length === 6) {
    r = parseInt(value.slice(0, 2), 16)
    g = parseInt(value.slice(2, 4), 16)
    b = parseInt(value.slice(4, 6), 16)
  }

  return new THREE.Vector3(r / 255, g / 255, b / 255)
}

function getLineCount(waveType) {
  if (typeof props.lineCount === 'number') return props.lineCount
  if (!props.enabledWaves.includes(waveType)) return 0
  const index = props.enabledWaves.indexOf(waveType)
  return props.lineCount[index] ?? 6
}

function getLineDistance(waveType) {
  if (typeof props.lineDistance === 'number') return props.lineDistance
  if (!props.enabledWaves.includes(waveType)) return 0.1
  const index = props.enabledWaves.indexOf(waveType)
  return props.lineDistance[index] ?? 0.1
}

let uniforms = null

function initThree() {
  const container = containerRef.value
  if (!container) return

  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  camera.position.z = 1

  const topLineCount = props.enabledWaves.includes('top') ? getLineCount('top') : 0
  const middleLineCount = props.enabledWaves.includes('middle') ? getLineCount('middle') : 0
  const bottomLineCount = props.enabledWaves.includes('bottom') ? getLineCount('bottom') : 0

  const topLineDistance = props.enabledWaves.includes('top') ? getLineDistance('top') * 0.01 : 0.01
  const middleLineDistance = props.enabledWaves.includes('middle') ? getLineDistance('middle') * 0.01 : 0.01
  const bottomLineDistance = props.enabledWaves.includes('bottom') ? getLineDistance('bottom') * 0.01 : 0.01

  const topWP = props.topWavePosition || { x: 10.0, y: 0.5, rotate: -0.4 }
  const middleWP = props.middleWavePosition || { x: 5.0, y: 0.0, rotate: 0.2 }
  const bottomWP = props.bottomWavePosition || { x: 2.0, y: -0.7, rotate: 0.4 }

  uniforms = {
    iTime: { value: 0 },
    iResolution: { value: new THREE.Vector3(1, 1, 1) },
    animationSpeed: { value: props.animationSpeed },

    enableTop: { value: props.enabledWaves.includes('top') },
    enableMiddle: { value: props.enabledWaves.includes('middle') },
    enableBottom: { value: props.enabledWaves.includes('bottom') },

    topLineCount: { value: topLineCount },
    middleLineCount: { value: middleLineCount },
    bottomLineCount: { value: bottomLineCount },

    topLineDistance: { value: topLineDistance },
    middleLineDistance: { value: middleLineDistance },
    bottomLineDistance: { value: bottomLineDistance },

    topWavePosition: { value: new THREE.Vector3(topWP.x, topWP.y, topWP.rotate) },
    middleWavePosition: { value: new THREE.Vector3(middleWP.x, middleWP.y, middleWP.rotate) },
    bottomWavePosition: { value: new THREE.Vector3(bottomWP.x, bottomWP.y, bottomWP.rotate) },

    iMouse: { value: new THREE.Vector2(-1000, -1000) },
    interactive: { value: props.interactive },
    bendRadius: { value: props.bendRadius },
    bendStrength: { value: props.bendStrength },
    bendInfluence: { value: 0 },

    parallax: { value: props.parallax },
    parallaxStrength: { value: props.parallaxStrength },
    parallaxOffset: { value: new THREE.Vector2(0, 0) },

    lineGradient: {
      value: Array.from({ length: MAX_GRADIENT_STOPS }, () => new THREE.Vector3(1, 1, 1))
    },
    lineGradientCount: { value: 0 }
  }

  updateColors()

  material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader
  })

  const geometry = new THREE.PlaneGeometry(2, 2)
  const mesh = new THREE.Mesh(geometry, material)
  scene.add(mesh)

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  container.appendChild(renderer.domElement)

  clock = new THREE.Clock()

  const setSize = () => {
    const width = container.clientWidth || 1
    const height = container.clientHeight || 1
    renderer.setSize(width, height, false)
    const canvasWidth = renderer.domElement.width
    const canvasHeight = renderer.domElement.height
    uniforms.iResolution.value.set(canvasWidth, canvasHeight, 1)
  }

  setSize()

  if ('ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(setSize)
    resizeObserver.observe(container)
  }

  const handlePointerMove = (event) => {
    const rect = renderer.domElement.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const dpr = renderer.getPixelRatio()
    targetMouse.set(x * dpr, (rect.height - y) * dpr)
    targetInfluence.value = 1.0

    if (props.parallax) {
      const centerX = rect.width / 2
      const centerY = rect.height / 2
      const offsetX = (x - centerX) / rect.width
      const offsetY = -(y - centerY) / rect.height
      targetParallax.set(offsetX * props.parallaxStrength, offsetY * props.parallaxStrength)
    }
  }

  const handlePointerLeave = () => {
    targetInfluence.value = 0.0
  }

  if (props.interactive) {
    renderer.domElement.addEventListener('pointermove', handlePointerMove)
    renderer.domElement.addEventListener('pointerleave', handlePointerLeave)
  }

  const renderLoop = () => {
    uniforms.iTime.value = clock.getElapsedTime()

    if (props.interactive) {
      currentMouse.lerp(targetMouse, props.mouseDamping)
      uniforms.iMouse.value.copy(currentMouse)

      currentInfluence.value += (targetInfluence.value - currentInfluence.value) * props.mouseDamping
      uniforms.bendInfluence.value = currentInfluence.value
    }

    if (props.parallax) {
      currentParallax.lerp(targetParallax, props.mouseDamping)
      uniforms.parallaxOffset.value.copy(currentParallax)
    }

    renderer.render(scene, camera)
    animationId = requestAnimationFrame(renderLoop)
  }
  animationId = requestAnimationFrame(renderLoop)
}

function updateColors() {
  if (!uniforms) return
  const stops = (props.linesGradient || []).slice(0, MAX_GRADIENT_STOPS)
  uniforms.lineGradientCount.value = stops.length
  stops.forEach((hex, i) => {
    const color = hexToVec3(hex)
    uniforms.lineGradient.value[i].set(color.x, color.y, color.z)
  })
}

onMounted(() => {
  initThree()
})

onBeforeUnmount(() => {
  if (animationId) cancelAnimationFrame(animationId)
  if (resizeObserver) resizeObserver.disconnect()
  if (material) material.dispose()
  if (renderer) {
    renderer.dispose()
    renderer.forceContextLoss()
    if (renderer.domElement.parentElement) {
      renderer.domElement.parentElement.removeChild(renderer.domElement)
    }
  }
})

watch(() => props.linesGradient, updateColors, { deep: true })
</script>

<style scoped>
.floating-lines-container {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
}
</style>
