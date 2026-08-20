import * as THREE from "three";

export type ScenePreset = "sakura_sunset" | "ocean_shinkai" | "cyber_lake" | "ghibli_forest";

export interface AudioBands {
	bass: number;     // 0..1
	mid: number;      // 0..1
	treble: number;   // 0..1
	energy: number;   // 0..1
}

interface PresetTheme {
	skyZenith: THREE.Color;
	skyHorizon: THREE.Color;
	skyGround: THREE.Color;
	sunColor: THREE.Color;
	sunPosition: THREE.Vector3;
	cloudColor: THREE.Color;
	cloudShadow: THREE.Color;
	waterDeep: THREE.Color;
	waterMid: THREE.Color;
	waterShallow: THREE.Color;
	waterFoam: THREE.Color;
	islandTop: THREE.Color;
	islandCliff: THREE.Color;
	foliageColor1: THREE.Color;
	foliageColor2: THREE.Color;
	foliageShadow: THREE.Color;
	trunkColor: THREE.Color;
	particleColor: THREE.Color;
	fogColor: THREE.Color;
	fogDensity: number;
	starBrightness: number;
}

const PRESETS: Record<ScenePreset, PresetTheme> = {
	sakura_sunset: {
		skyZenith: new THREE.Color(0x35194d),
		skyHorizon: new THREE.Color(0xf68388),
		skyGround: new THREE.Color(0xffb89d),
		sunColor: new THREE.Color(0xffecd2),
		sunPosition: new THREE.Vector3(12, 18, -45),
		cloudColor: new THREE.Color(0xffe3eb),
		cloudShadow: new THREE.Color(0xb26b8e),
		waterDeep: new THREE.Color(0x1d1338),
		waterMid: new THREE.Color(0x56235e),
		waterShallow: new THREE.Color(0xff8da1),
		waterFoam: new THREE.Color(0xfff3f8),
		islandTop: new THREE.Color(0x36482e),
		islandCliff: new THREE.Color(0x1e1927),
		foliageColor1: new THREE.Color(0xff9cb6),
		foliageColor2: new THREE.Color(0xff678a),
		foliageShadow: new THREE.Color(0x8c2658),
		trunkColor: new THREE.Color(0x432822),
		particleColor: new THREE.Color(0xffc2d1),
		fogColor: new THREE.Color(0x5c2b66),
		fogDensity: 0.008,
		starBrightness: 0.25,
	},
	ocean_shinkai: {
		skyZenith: new THREE.Color(0x04081c),
		skyHorizon: new THREE.Color(0x0e2f56),
		skyGround: new THREE.Color(0x08182b),
		sunColor: new THREE.Color(0xa8ecff),
		sunPosition: new THREE.Vector3(-15, 22, -45),
		cloudColor: new THREE.Color(0x386b99),
		cloudShadow: new THREE.Color(0x0d2238),
		waterDeep: new THREE.Color(0x030f24),
		waterMid: new THREE.Color(0x08335e),
		waterShallow: new THREE.Color(0x00d2ff),
		waterFoam: new THREE.Color(0xdefbff),
		islandTop: new THREE.Color(0x1a3330),
		islandCliff: new THREE.Color(0x0b1721),
		foliageColor1: new THREE.Color(0x00f0e0),
		foliageColor2: new THREE.Color(0x0995a8),
		foliageShadow: new THREE.Color(0x043247),
		trunkColor: new THREE.Color(0x16222b),
		particleColor: new THREE.Color(0x75f4ff),
		fogColor: new THREE.Color(0x091c36),
		fogDensity: 0.01,
		starBrightness: 0.9,
	},
	cyber_lake: {
		skyZenith: new THREE.Color(0x0c0217),
		skyHorizon: new THREE.Color(0x3b003a),
		skyGround: new THREE.Color(0x1a0026),
		sunColor: new THREE.Color(0xff007f),
		sunPosition: new THREE.Vector3(0, 16, -45),
		cloudColor: new THREE.Color(0x751b75),
		cloudShadow: new THREE.Color(0x240033),
		waterDeep: new THREE.Color(0x0d001c),
		waterMid: new THREE.Color(0x38004d),
		waterShallow: new THREE.Color(0xff0080),
		waterFoam: new THREE.Color(0x00ffff),
		islandTop: new THREE.Color(0x28103d),
		islandCliff: new THREE.Color(0x0e0317),
		foliageColor1: new THREE.Color(0x00f5d4),
		foliageColor2: new THREE.Color(0x7b2cbf),
		foliageShadow: new THREE.Color(0x240046),
		trunkColor: new THREE.Color(0x12002e),
		particleColor: new THREE.Color(0x00ffff),
		fogColor: new THREE.Color(0x1d0038),
		fogDensity: 0.012,
		starBrightness: 0.7,
	},
	ghibli_forest: {
		skyZenith: new THREE.Color(0x1c6db8),
		skyHorizon: new THREE.Color(0x8ce1ff),
		skyGround: new THREE.Color(0xc2f0ff),
		sunColor: new THREE.Color(0xfffae6),
		sunPosition: new THREE.Vector3(18, 26, -40),
		cloudColor: new THREE.Color(0xffffff),
		cloudShadow: new THREE.Color(0x94c1e0),
		waterDeep: new THREE.Color(0x074558),
		waterMid: new THREE.Color(0x0f798a),
		waterShallow: new THREE.Color(0x38efdb),
		waterFoam: new THREE.Color(0xffffff),
		islandTop: new THREE.Color(0x407c1e),
		islandCliff: new THREE.Color(0x2e251a),
		foliageColor1: new THREE.Color(0x72db00),
		foliageColor2: new THREE.Color(0x38a800),
		foliageShadow: new THREE.Color(0x00471f),
		trunkColor: new THREE.Color(0x523829),
		particleColor: new THREE.Color(0xffea9f),
		fogColor: new THREE.Color(0x7ec6f8),
		fogDensity: 0.007,
		starBrightness: 0.0,
	},
};

// ==========================================
// 1. Stylized Anime Sky Dome & Clouds Shader
// ==========================================
const SkyVertexShader = `
varying vec3 vWorldPosition;
varying vec2 vUv;

void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const SkyFragmentShader = `
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform vec3 uSunPosition;
uniform vec3 uSunColor;
uniform vec3 uCloudColor;
uniform vec3 uCloudShadow;
uniform float uTime;
uniform float uStarBrightness;

varying vec3 vWorldPosition;
varying vec2 vUv;

// Procedural 2D noise for anime cumulus clouds
float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
    for (int i = 0; i < 4; i++) {
        v += a * noise(p);
        p = rot * p * 2.0 + vec2(uTime * 0.015);
        a *= 0.5;
    }
    return v;
}

void main() {
    vec3 dir = normalize(vWorldPosition);
    float height = dir.y;

    // Stepped Toon Sky Gradient
    vec3 skyColor = mix(uSkyHorizon, uSkyZenith, smoothstep(0.0, 0.85, max(0.0, height)));
    if (height < 0.0) {
        skyColor = mix(uSkyHorizon, uSkyGround, clamp(-height * 3.0, 0.0, 1.0));
    }

    // Anime Celestial Sun / Moon Disk with Stepped Glow Aura
    vec3 sunDir = normalize(uSunPosition);
    float sunDot = max(0.0, dot(dir, sunDir));
    float sunDisk = step(0.996, sunDot);
    float sunHalo1 = smoothstep(0.96, 0.995, sunDot) * 0.5;
    float sunHalo2 = smoothstep(0.85, 0.96, sunDot) * 0.25;
    skyColor += (sunDisk + sunHalo1 + sunHalo2) * uSunColor;

    // Starfield for night themes
    if (uStarBrightness > 0.05 && height > 0.1) {
        vec2 starUv = dir.xz / (height + 0.15) * 85.0;
        float starNoise = hash(floor(starUv));
        if (starNoise > 0.985) {
            float twinkle = sin(uTime * 4.0 + starNoise * 20.0) * 0.5 + 0.5;
            skyColor += vec3(twinkle * uStarBrightness * smoothstep(0.1, 0.5, height));
        }
    }

    // Anime Drifting Cumulus Cloud Layer
    if (height > 0.05) {
        vec2 cloudUv = (dir.xz / (height + 0.25)) * 1.8 + vec2(uTime * 0.012, uTime * 0.005);
        float cloudShape = fbm(cloudUv);

        // Cel thresholding for sharp anime cloud silhouettes
        float cloudMask = smoothstep(0.48, 0.55, cloudShape);
        float cloudLight = smoothstep(0.55, 0.68, cloudShape);

        vec3 cloudFinal = mix(uCloudShadow, uCloudColor, cloudLight);
        skyColor = mix(skyColor, cloudFinal, cloudMask * smoothstep(0.05, 0.3, height));
    }

    gl_FragColor = vec4(skyColor, 1.0);
}
`;

// ==========================================
// 2. Stylized Anime Water & Waves Shader
// ==========================================
const WaterVertexShader = `
uniform float uTime;
uniform float uBass;
uniform float uWaveSpeed;
uniform float uWaveHeight;

varying vec3 vWorldPosition;
varying vec3 vNormal;
varying vec2 vUv;
varying float vElevation;

vec3 gerstnerWave(vec4 wave, vec3 p, inout vec3 tangent, inout vec3 binormal) {
    float steepness = wave.z;
    float wavelength = wave.w;
    float k = 2.0 * 3.14159265 / wavelength;
    float c = sqrt(9.8 / k);
    vec2 d = normalize(wave.xy);
    float f = k * (dot(d, p.xz) - c * uTime * uWaveSpeed);
    float a = steepness / k;

    tangent += vec3(
        -d.x * d.x * (steepness * sin(f)),
        d.x * (steepness * cos(f)),
        -d.x * d.y * (steepness * sin(f))
    );
    binormal += vec3(
        -d.x * d.y * (steepness * sin(f)),
        d.y * (steepness * cos(f)),
        -d.y * d.y * (steepness * sin(f))
    );

    return vec3(
        d.x * (a * cos(f)),
        a * sin(f),
        d.y * (a * cos(f))
    );
}

void main() {
    vUv = uv;
    vec3 gridPoint = position;
    vec3 tangent = vec3(1.0, 0.0, 0.0);
    vec3 binormal = vec3(0.0, 0.0, 1.0);
    vec3 p = gridPoint;

    // Reactivity to live bass transients
    float bassScale = 1.0 + uBass * 1.6;
    float h = uWaveHeight * bassScale;

    // 3 overlapping Gerstner wave trains
    vec4 w1 = vec4(1.0, 0.4, 0.18 * h, 16.0);
    vec4 w2 = vec4(0.3, 1.0, 0.12 * h, 9.0);
    vec4 w3 = vec4(-0.6, 0.7, 0.07 * h, 5.5);

    p += gerstnerWave(w1, gridPoint, tangent, binormal);
    p += gerstnerWave(w2, gridPoint, tangent, binormal);
    p += gerstnerWave(w3, gridPoint, tangent, binormal);

    vec3 normal = normalize(cross(binormal, tangent));
    vNormal = normalMatrix * normal;
    vElevation = p.y;

    vec4 worldPos = modelMatrix * vec4(p, 1.0);
    vWorldPosition = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const WaterFragmentShader = `
uniform vec3 uWaterDeep;
uniform vec3 uWaterMid;
uniform vec3 uWaterShallow;
uniform vec3 uWaterFoam;
uniform vec3 uSunPosition;
uniform vec3 uSunColor;
uniform float uTime;
uniform float uTreble;
uniform vec3 uFogColor;
uniform float uFogDensity;

varying vec3 vWorldPosition;
varying vec3 vNormal;
varying vec2 vUv;
varying float vElevation;

// Cellular Voronoi pattern for sharp water foam caustics
vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

float voronoi(vec2 p) {
    vec2 n = floor(p);
    vec2 f = fract(p);
    float md = 5.0;
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            vec2 g = vec2(float(i), float(j));
            vec2 o = hash2(n + g);
            o = 0.5 + 0.5 * sin(uTime * 2.0 + 6.2831 * o);
            vec2 r = g + o - f;
            float d = dot(r, r);
            if (d < md) md = d;
        }
    }
    return sqrt(md);
}

void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorldPosition);
    vec3 L = normalize(uSunPosition);

    // Fresnel rim light for stylized glass/water edge
    float NdotV = max(0.0, dot(N, V));
    float fresnel = pow(1.0 - NdotV, 3.5);

    // 4-Tier Discrete Cel Color Palette based on wave depth & elevation
    float depth = clamp((vElevation + 0.9) * 0.65, 0.0, 1.0);
    vec3 waterColor = uWaterDeep;
    if (depth > 0.28) waterColor = mix(uWaterDeep, uWaterMid, smoothstep(0.28, 0.35, depth));
    if (depth > 0.62) waterColor = mix(uWaterMid, uWaterShallow, smoothstep(0.62, 0.70, depth));

    // Foam crest lines on high waves
    float foamNoise = voronoi(vWorldPosition.xz * 0.45);
    float foamMask = smoothstep(0.35, 0.48, vElevation) * smoothstep(0.25, 0.45, foamNoise);

    // Treble-reactive glistening star highlights
    vec3 H = normalize(L + V);
    float NdotH = max(0.0, dot(N, H));
    float spec = pow(NdotH, 96.0);
    float starGlint = step(0.82, spec) * (1.2 + uTreble * 2.0);

    vec3 finalColor = mix(waterColor, uWaterFoam, foamMask * 0.85);
    finalColor = mix(finalColor, uWaterShallow * 1.3, fresnel * 0.65);
    finalColor += starGlint * uSunColor;

    // Distance atmospheric fog blend
    float dist = length(cameraPosition - vWorldPosition);
    float fogFactor = 1.0 - exp(-dist * dist * uFogDensity * uFogDensity);
    finalColor = mix(finalColor, uFogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(finalColor, 0.94);
}
`;

// ==========================================
// 3. Black Ink Anime Cel Outline Shaders
// ==========================================
const OutlineVertexShader = `
uniform float uOutlineWidth;

void main() {
    // Inverted hull extrusion along vertex normal
    vec3 transformed = position + normal * uOutlineWidth;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
}
`;

const OutlineFragmentShader = `
uniform vec3 uOutlineColor;

void main() {
    gl_FragColor = vec4(uOutlineColor, 1.0);
}
`;

// ==========================================
// 4. Stylized Ghibli Foliage Shader
// ==========================================
const FoliageVertexShader = `
uniform float uTime;
uniform float uMid;
uniform float uWindSpeed;

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec2 vUv;

void main() {
    vUv = uv;
    vec3 p = position;

    // Audio-reactive wind sway (mid frequencies)
    float swayAmp = 0.22 + uMid * 0.55;
    float wind = sin(uTime * uWindSpeed + p.x * 0.6 + p.y * 0.9) * cos(uTime * uWindSpeed * 0.8 + p.z * 0.6);
    p.x += wind * swayAmp * (p.y * 0.12);
    p.z += wind * 0.45 * swayAmp * (p.y * 0.12);

    vec4 worldPos = modelMatrix * vec4(p, 1.0);
    vWorldPosition = worldPos.xyz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const FoliageFragmentShader = `
uniform vec3 uFoliageColor1;
uniform vec3 uFoliageColor2;
uniform vec3 uFoliageShadow;
uniform vec3 uSunPosition;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform float uFogDensity;

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec2 vUv;

void main() {
    vec3 N = normalize(vNormal);
    vec3 L = normalize(uSunPosition);
    vec3 V = normalize(cameraPosition - vWorldPosition);

    float NdotL = dot(N, L);
    // 3-Tone discrete stepped Ghibli anime shading
    float tone = 0.0;
    if (NdotL > -0.15) tone = 0.5;
    if (NdotL > 0.28)  tone = 1.0;

    vec3 baseColor = mix(uFoliageColor2, uFoliageColor1, tone);
    vec3 litColor = mix(uFoliageShadow, baseColor, smoothstep(0.0, 0.5, tone));

    // Anime Rim / Backlight Glow
    float rim = 1.0 - max(0.0, dot(N, V));
    rim = smoothstep(0.68, 0.92, rim) * max(0.0, dot(-L, V) + 0.35);
    litColor += rim * uSunColor * 0.45;

    // Distance fog
    float dist = length(cameraPosition - vWorldPosition);
    float fogFactor = 1.0 - exp(-dist * dist * uFogDensity * uFogDensity);
    vec3 finalColor = mix(litColor, uFogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(finalColor, 1.0);
}
`;

export class Stylized3DScene {
	private container: HTMLElement;
	private canvas: HTMLCanvasElement;
	private renderer: THREE.WebGLRenderer;
	private scene: THREE.Scene;
	private camera: THREE.PerspectiveCamera;
	private skyMaterial!: THREE.ShaderMaterial;
	private waterMaterial!: THREE.ShaderMaterial;
	private foliageMaterial!: THREE.ShaderMaterial;
	private outlineMaterial!: THREE.ShaderMaterial;
	private particleSystem!: THREE.Points;
	private particleGeo!: THREE.BufferGeometry;
	private particleVelocities!: Float32Array;
	private trees: THREE.Group[] = [];
	private islands: THREE.Group[] = [];
	private preset: ScenePreset = "sakura_sunset";
	private clock = new THREE.Clock();
	private running = false;
	private visible = true;
	private targetOpacity = 0.25;
	private rafId: number | null = null;
	private mouseX = 0;
	private mouseY = 0;
	private targetCamX = 0;
	private targetCamY = 7;
	private currentBands: AudioBands = { bass: 0, mid: 0, treble: 0, energy: 0 };
	private resizeObserver: ResizeObserver;

	constructor(container: HTMLElement, preset: ScenePreset = "sakura_sunset", initialOpacity: number = 0.25) {
		this.container = container;
		this.preset = preset;
		this.targetOpacity = initialOpacity;

		this.canvas = document.createElement("canvas");
		this.canvas.className = "stylized-3d-canvas";
		this.canvas.style.cssText = `
			position: absolute;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			pointer-events: none;
			z-index: 0;
			opacity: ${initialOpacity};
			transition: opacity 0.5s ease;
		`;
		this.container.appendChild(this.canvas);

		this.scene = new THREE.Scene();
		this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 800);
		this.camera.position.set(0, 6.5, 26);
		this.camera.lookAt(0, 2.8, 0);

		this.renderer = new THREE.WebGLRenderer({
			canvas: this.canvas,
			antialias: true,
			alpha: false,
			powerPreference: "high-performance",
		});
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.15;

		this.buildScene();
		this.applyPreset(this.preset);
		this.handleResize();

		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.container);

		window.addEventListener("mousemove", this.onMouseMove);
	}

	private onMouseMove = (e: MouseEvent) => {
		const nx = (e.clientX / window.innerWidth) * 2 - 1;
		const ny = (e.clientY / window.innerHeight) * 2 - 1;
		this.mouseX = nx;
		this.mouseY = ny;
	};

	private handleResize() {
		const rect = this.container.getBoundingClientRect();
		const w = Math.max(1, rect.width);
		const h = Math.max(1, rect.height);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(w, h);
	}

	public setPreset(preset: ScenePreset) {
		this.preset = preset;
		this.applyPreset(preset);
	}

	public setOpacity(opacity: number) {
		this.targetOpacity = Math.max(0, Math.min(1, opacity));
		if (this.visible) {
			this.canvas.style.opacity = String(this.targetOpacity);
		}
	}

	public setVisible(visible: boolean) {
		this.visible = visible;
		this.canvas.style.opacity = visible ? String(this.targetOpacity) : "0";
		if (visible && !this.running) {
			this.start();
		} else if (!visible && this.running) {
			this.stop();
		}
	}

	private applyPreset(pName: ScenePreset) {
		const theme = PRESETS[pName] || PRESETS.sakura_sunset;

		// Sky uniforms
		if (this.skyMaterial) {
			this.skyMaterial.uniforms.uSkyZenith.value.copy(theme.skyZenith);
			this.skyMaterial.uniforms.uSkyHorizon.value.copy(theme.skyHorizon);
			this.skyMaterial.uniforms.uSkyGround.value.copy(theme.skyGround);
			this.skyMaterial.uniforms.uSunColor.value.copy(theme.sunColor);
			this.skyMaterial.uniforms.uSunPosition.value.copy(theme.sunPosition);
			this.skyMaterial.uniforms.uCloudColor.value.copy(theme.cloudColor);
			this.skyMaterial.uniforms.uCloudShadow.value.copy(theme.cloudShadow);
			this.skyMaterial.uniforms.uStarBrightness.value = theme.starBrightness;
		}

		// Water uniforms
		if (this.waterMaterial) {
			this.waterMaterial.uniforms.uWaterDeep.value.copy(theme.waterDeep);
			this.waterMaterial.uniforms.uWaterMid.value.copy(theme.waterMid);
			this.waterMaterial.uniforms.uWaterShallow.value.copy(theme.waterShallow);
			this.waterMaterial.uniforms.uWaterFoam.value.copy(theme.waterFoam);
			this.waterMaterial.uniforms.uSunColor.value.copy(theme.sunColor);
			this.waterMaterial.uniforms.uSunPosition.value.copy(theme.sunPosition);
			this.waterMaterial.uniforms.uFogColor.value.copy(theme.fogColor);
			this.waterMaterial.uniforms.uFogDensity.value = theme.fogDensity;
		}

		// Foliage uniforms
		if (this.foliageMaterial) {
			this.foliageMaterial.uniforms.uFoliageColor1.value.copy(theme.foliageColor1);
			this.foliageMaterial.uniforms.uFoliageColor2.value.copy(theme.foliageColor2);
			this.foliageMaterial.uniforms.uFoliageShadow.value.copy(theme.foliageShadow);
			this.foliageMaterial.uniforms.uSunColor.value.copy(theme.sunColor);
			this.foliageMaterial.uniforms.uSunPosition.value.copy(theme.sunPosition);
			this.foliageMaterial.uniforms.uFogColor.value.copy(theme.fogColor);
			this.foliageMaterial.uniforms.uFogDensity.value = theme.fogDensity;
		}

		// Particles color
		if (this.particleSystem) {
			const mat = this.particleSystem.material as THREE.PointsMaterial;
			mat.color.copy(theme.particleColor);
		}
	}

	private buildScene() {
		// 1. Stylized Anime Sky Dome
		const skyGeo = new THREE.SphereGeometry(300, 32, 24);
		this.skyMaterial = new THREE.ShaderMaterial({
			vertexShader: SkyVertexShader,
			fragmentShader: SkyFragmentShader,
			uniforms: {
				uTime: { value: 0 },
				uSkyZenith: { value: new THREE.Color() },
				uSkyHorizon: { value: new THREE.Color() },
				uSkyGround: { value: new THREE.Color() },
				uSunPosition: { value: new THREE.Vector3(12, 18, -45) },
				uSunColor: { value: new THREE.Color() },
				uCloudColor: { value: new THREE.Color() },
				uCloudShadow: { value: new THREE.Color() },
				uStarBrightness: { value: 0.3 },
			},
			side: THREE.BackSide,
			depthWrite: false,
		});
		const skyMesh = new THREE.Mesh(skyGeo, this.skyMaterial);
		this.scene.add(skyMesh);

		// 2. Black Ink Anime Outline Material
		this.outlineMaterial = new THREE.ShaderMaterial({
			vertexShader: OutlineVertexShader,
			fragmentShader: OutlineFragmentShader,
			uniforms: {
				uOutlineWidth: { value: 0.05 },
				uOutlineColor: { value: new THREE.Color(0x0a0914) },
			},
			side: THREE.BackSide,
		});

		// 3. Water Ocean Plane
		const waterGeo = new THREE.PlaneGeometry(140, 140, 160, 160);
		waterGeo.rotateX(-Math.PI / 2);

		this.waterMaterial = new THREE.ShaderMaterial({
			vertexShader: WaterVertexShader,
			fragmentShader: WaterFragmentShader,
			uniforms: {
				uTime: { value: 0 },
				uBass: { value: 0 },
				uTreble: { value: 0 },
				uWaveSpeed: { value: 1.1 },
				uWaveHeight: { value: 0.7 },
				uWaterDeep: { value: new THREE.Color() },
				uWaterMid: { value: new THREE.Color() },
				uWaterShallow: { value: new THREE.Color() },
				uWaterFoam: { value: new THREE.Color() },
				uSunPosition: { value: new THREE.Vector3(12, 18, -45) },
				uSunColor: { value: new THREE.Color() },
				uFogColor: { value: new THREE.Color() },
				uFogDensity: { value: 0.008 },
			},
			transparent: true,
			wireframe: false,
		});

		const waterMesh = new THREE.Mesh(waterGeo, this.waterMaterial);
		waterMesh.position.y = -0.4;
		this.scene.add(waterMesh);

		// 4. Foliage Material for Ghibli Anime Trees
		this.foliageMaterial = new THREE.ShaderMaterial({
			vertexShader: FoliageVertexShader,
			fragmentShader: FoliageFragmentShader,
			uniforms: {
				uTime: { value: 0 },
				uMid: { value: 0 },
				uWindSpeed: { value: 1.4 },
				uFoliageColor1: { value: new THREE.Color() },
				uFoliageColor2: { value: new THREE.Color() },
				uFoliageShadow: { value: new THREE.Color() },
				uSunPosition: { value: new THREE.Vector3(12, 18, -45) },
				uSunColor: { value: new THREE.Color() },
				uFogColor: { value: new THREE.Color() },
				uFogDensity: { value: 0.008 },
			},
		});

		// 5. Tiered Sculpted Islands with Ink Outline
		this.createTieredIsland(0, -0.6, -2, 8.0, 2.5, 0x223326, 0x181a24);
		this.createTieredIsland(-15, -0.7, -13, 6.0, 2.0, 0x1d2e20, 0x14151e);
		this.createTieredIsland(16, -0.7, -11, 6.5, 2.2, 0x1f3022, 0x151620);

		// 6. Spawn Detailed Anime Trees with Outlines
		this.createAnimeTree(0, 1.4, -2, 1.35);
		this.createAnimeTree(-3.0, 1.0, -1.0, 0.95);
		this.createAnimeTree(2.8, 0.9, -3.2, 1.05);
		this.createAnimeTree(-14.5, 0.9, -12.5, 1.15);
		this.createAnimeTree(15.2, 1.0, -10.5, 1.2);

		// 7. Calmer Sakura / Ember Floating Particles (Reduced to 45 elegant petals)
		this.createParticles(45);
	}

	private createTieredIsland(x: number, y: number, z: number, rad: number, height: number, topCol: number, cliffCol: number) {
		const group = new THREE.Group();
		group.position.set(x, y, z);

		// Base rocky cliff
		const cliffGeo = new THREE.CylinderGeometry(rad * 0.88, rad * 1.05, height, 18);
		const cliffMat = new THREE.MeshBasicMaterial({ color: cliffCol });
		const cliffMesh = new THREE.Mesh(cliffGeo, cliffMat);
		cliffMesh.position.y = height / 2;
		group.add(cliffMesh);

		// Black outline for island cliff
		const cliffOutline = new THREE.Mesh(cliffGeo, this.outlineMaterial);
		cliffOutline.position.y = height / 2;
		group.add(cliffOutline);

		// Mossy green plateau cap
		const capGeo = new THREE.CylinderGeometry(rad * 0.92, rad * 0.9, 0.4, 18);
		const capMat = new THREE.MeshBasicMaterial({ color: topCol });
		const capMesh = new THREE.Mesh(capGeo, capMat);
		capMesh.position.y = height + 0.15;
		group.add(capMesh);

		// Black outline for cap
		const capOutline = new THREE.Mesh(capGeo, this.outlineMaterial);
		capOutline.position.y = height + 0.15;
		group.add(capOutline);

		this.scene.add(group);
		this.islands.push(group);
	}

	private createAnimeTree(x: number, y: number, z: number, scale: number) {
		const treeGroup = new THREE.Group();
		treeGroup.position.set(x, y, z);
		treeGroup.scale.setScalar(scale);

		// Detailed curved trunk
		const trunkGeo = new THREE.CylinderGeometry(0.18, 0.48, 3.4, 10);
		const trunkMat = new THREE.MeshBasicMaterial({ color: 0x3d2719 });
		const trunk = new THREE.Mesh(trunkGeo, trunkMat);
		trunk.position.y = 1.7;
		treeGroup.add(trunk);

		// Black outline on trunk
		const trunkOutline = new THREE.Mesh(trunkGeo, this.outlineMaterial);
		trunkOutline.position.y = 1.7;
		treeGroup.add(trunkOutline);

		// Fluffy Ghibli foliage clusters with black contour outlines
		const clusterCoords = [
			[0, 3.8, 0, 1.55],
			[-1.0, 3.3, 0.4, 1.15],
			[0.9, 3.4, -0.4, 1.2],
			[0.2, 4.6, 0.1, 1.25],
			[-0.5, 4.0, -0.8, 1.05],
			[0.6, 4.1, 0.7, 1.1],
		];

		for (const [cx, cy, cz, cr] of clusterCoords) {
			const foliageGeo = new THREE.DodecahedronGeometry(cr, 2);
			const pos = foliageGeo.attributes.position;
			for (let i = 0; i < pos.count; i++) {
				const vx = pos.getX(i);
				const vy = pos.getY(i);
				const vz = pos.getZ(i);
				const noise = 1.0 + (Math.sin(vx * 2.8) + Math.cos(vy * 2.8)) * 0.09;
				pos.setXYZ(i, vx * noise, vy * noise, vz * noise);
			}
			foliageGeo.computeVertexNormals();

			// Core foliage mesh
			const foliageClump = new THREE.Mesh(foliageGeo, this.foliageMaterial);
			foliageClump.position.set(cx, cy, cz);
			treeGroup.add(foliageClump);

			// Black ink outline mesh
			const outlineClump = new THREE.Mesh(foliageGeo, this.outlineMaterial);
			outlineClump.position.set(cx, cy, cz);
			treeGroup.add(outlineClump);
		}

		this.scene.add(treeGroup);
		this.trees.push(treeGroup);
	}

	private createParticles(count: number) {
		this.particleGeo = new THREE.BufferGeometry();
		const positions = new Float32Array(count * 3);
		this.particleVelocities = new Float32Array(count * 3);

		for (let i = 0; i < count; i++) {
			positions[i * 3] = (Math.random() - 0.5) * 40;
			positions[i * 3 + 1] = Math.random() * 16 + 1.0;
			positions[i * 3 + 2] = (Math.random() - 0.5) * 40;

			this.particleVelocities[i * 3] = (Math.random() - 0.5) * 0.025;
			this.particleVelocities[i * 3 + 1] = -(Math.random() * 0.02 + 0.008);
			this.particleVelocities[i * 3 + 2] = (Math.random() - 0.5) * 0.025;
		}

		this.particleGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

		const particleMat = new THREE.PointsMaterial({
			size: 0.42,
			color: 0xffb7c5,
			transparent: true,
			opacity: 0.85,
			blending: THREE.AdditiveBlending,
			depthWrite: false,
		});

		this.particleSystem = new THREE.Points(this.particleGeo, particleMat);
		this.scene.add(this.particleSystem);
	}

	public updateAudio(bands: AudioBands) {
		this.currentBands = bands;
		if (this.waterMaterial) {
			this.waterMaterial.uniforms.uBass.value = bands.bass;
			this.waterMaterial.uniforms.uTreble.value = bands.treble;
		}
		if (this.foliageMaterial) {
			this.foliageMaterial.uniforms.uMid.value = bands.mid;
		}
	}

	public start() {
		if (this.running) return;
		this.running = true;
		this.clock.start();
		this.renderLoop();
	}

	public stop() {
		this.running = false;
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	private renderLoop = () => {
		if (!this.running) return;
		this.rafId = requestAnimationFrame(this.renderLoop);

		const time = this.clock.getElapsedTime();

		// Update shader uniforms
		if (this.skyMaterial) {
			this.skyMaterial.uniforms.uTime.value = time;
		}
		if (this.waterMaterial) {
			this.waterMaterial.uniforms.uTime.value = time;
		}
		if (this.foliageMaterial) {
			this.foliageMaterial.uniforms.uTime.value = time;
		}

		// Smooth camera parallax tilt
		this.targetCamX = this.mouseX * 3.0;
		this.targetCamY = 6.5 - this.mouseY * 1.8;
		this.camera.position.x += (this.targetCamX - this.camera.position.x) * 0.04;
		this.camera.position.y += (this.targetCamY - this.camera.position.y) * 0.04;
		this.camera.lookAt(0, 2.5, 0);

		// Animate calm floating sakura petals
		if (this.particleGeo && this.particleVelocities) {
			const posAttr = this.particleGeo.attributes.position;
			const posArr = posAttr.array as Float32Array;
			const count = posArr.length / 3;
			const swirl = 1.0 + this.currentBands.mid * 2.0;

			for (let i = 0; i < count; i++) {
				const idx = i * 3;
				posArr[idx] += (this.particleVelocities[idx] + Math.sin(time * 0.8 + i) * 0.015) * swirl;
				posArr[idx + 1] += this.particleVelocities[idx + 1];
				posArr[idx + 2] += (this.particleVelocities[idx + 2] + Math.cos(time * 0.8 + i) * 0.015) * swirl;

				if (posArr[idx + 1] < 0.1 || Math.abs(posArr[idx]) > 25 || Math.abs(posArr[idx + 2]) > 25) {
					posArr[idx] = (Math.random() - 0.5) * 38;
					posArr[idx + 1] = 14 + Math.random() * 3;
					posArr[idx + 2] = (Math.random() - 0.5) * 38;
				}
			}
			posAttr.needsUpdate = true;
		}

		this.renderer.render(this.scene, this.camera);
	};

	public destroy() {
		this.stop();
		window.removeEventListener("mousemove", this.onMouseMove);
		this.resizeObserver.disconnect();
		this.renderer.dispose();
		if (this.canvas.parentElement) {
			this.canvas.parentElement.removeChild(this.canvas);
		}
	}
}
