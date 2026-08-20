import * as THREE from "three";

export type ScenePreset = "sakura_sunset" | "ocean_shinkai" | "cyber_lake" | "ghibli_forest";

export interface AudioBands {
	bass: number;     // 0..1
	mid: number;      // 0..1
	treble: number;   // 0..1
	energy: number;   // 0..1
}

interface PresetTheme {
	skyTop: THREE.Color;
	skyBottom: THREE.Color;
	waterDeep: THREE.Color;
	waterShallow: THREE.Color;
	waterFoam: THREE.Color;
	foliageColor1: THREE.Color;
	foliageColor2: THREE.Color;
	foliageShadow: THREE.Color;
	trunkColor: THREE.Color;
	particleColor: THREE.Color;
	sunColor: THREE.Color;
	fogColor: THREE.Color;
	fogDensity: number;
}

const PRESETS: Record<ScenePreset, PresetTheme> = {
	sakura_sunset: {
		skyTop: new THREE.Color(0x3a1c54),
		skyBottom: new THREE.Color(0xf68989),
		waterDeep: new THREE.Color(0x281b45),
		waterShallow: new THREE.Color(0xff8c94),
		waterFoam: new THREE.Color(0xfff0f5),
		foliageColor1: new THREE.Color(0xff9bb2),
		foliageColor2: new THREE.Color(0xff6584),
		foliageShadow: new THREE.Color(0x8a2b53),
		trunkColor: new THREE.Color(0x4a2e2b),
		particleColor: new THREE.Color(0xffb7c5),
		sunColor: new THREE.Color(0xffdf9e),
		fogColor: new THREE.Color(0x5a2d68),
		fogDensity: 0.012,
	},
	ocean_shinkai: {
		skyTop: new THREE.Color(0x060c24),
		skyBottom: new THREE.Color(0x133863),
		waterDeep: new THREE.Color(0x04132b),
		waterShallow: new THREE.Color(0x00d2ff),
		waterFoam: new THREE.Color(0xddfbff),
		foliageColor1: new THREE.Color(0x00e1d9),
		foliageColor2: new THREE.Color(0x0f8a9d),
		foliageShadow: new THREE.Color(0x063147),
		trunkColor: new THREE.Color(0x1e272e),
		particleColor: new THREE.Color(0x70efff),
		sunColor: new THREE.Color(0x8ae6ff),
		fogColor: new THREE.Color(0x081a38),
		fogDensity: 0.015,
	},
	cyber_lake: {
		skyTop: new THREE.Color(0x0f051d),
		skyBottom: new THREE.Color(0x400036),
		waterDeep: new THREE.Color(0x120024),
		waterShallow: new THREE.Color(0xff007f),
		waterFoam: new THREE.Color(0x00ffff),
		foliageColor1: new THREE.Color(0x00f5d4),
		foliageColor2: new THREE.Color(0x7b2cbf),
		foliageShadow: new THREE.Color(0x240046),
		trunkColor: new THREE.Color(0x10002b),
		particleColor: new THREE.Color(0x00f5d4),
		sunColor: new THREE.Color(0xff007f),
		fogColor: new THREE.Color(0x1b003a),
		fogDensity: 0.018,
	},
	ghibli_forest: {
		skyTop: new THREE.Color(0x1e6fba),
		skyBottom: new THREE.Color(0x99e5ff),
		waterDeep: new THREE.Color(0x084c61),
		waterShallow: new THREE.Color(0x40e0d0),
		waterFoam: new THREE.Color(0xffffff),
		foliageColor1: new THREE.Color(0x70e000),
		foliageColor2: new THREE.Color(0x38b000),
		foliageShadow: new THREE.Color(0x004b23),
		trunkColor: new THREE.Color(0x5c4033),
		particleColor: new THREE.Color(0xfff3b0),
		sunColor: new THREE.Color(0xfff8db),
		fogColor: new THREE.Color(0x73c2fb),
		fogDensity: 0.01,
	},
};

// ---------- Water Custom Cel Shader ----------
const WaterVertexShader = `
uniform float uTime;
uniform float uBass;
uniform float uWaveSpeed;
uniform float uWaveHeight;

varying vec3 vWorldPosition;
varying vec3 vNormal;
varying vec2 vUv;
varying float vElevation;

// Gerstner wave helper
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

    // Reactivity to bass kicks
    float bassScale = 1.0 + uBass * 1.8;
    float height = uWaveHeight * bassScale;

    // 3 overlapping Gerstner wave trains for stylized organic ocean flow
    vec4 w1 = vec4(1.0, 0.5, 0.18 * height, 18.0);
    vec4 w2 = vec4(0.4, 1.0, 0.12 * height, 10.0);
    vec4 w3 = vec4(-0.7, 0.6, 0.08 * height, 6.0);

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

// Procedural Voronoi / Water Caustics for cel anime sparkle
float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
}

vec2 hash22(vec2 p) {
    float n = hash21(p);
    return vec2(n, hash21(p + n));
}

float voronoi(vec2 p) {
    vec2 g = floor(p);
    vec2 f = fract(p);
    float minDist = 1.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 lattice = vec2(float(x), float(y));
            vec2 offset = hash22(g + lattice);
            offset = 0.5 + 0.5 * sin(uTime * 1.5 + 6.2831 * offset);
            vec2 d = lattice + offset - f;
            float dist = length(d);
            minDist = min(minDist, dist);
        }
    }
    return minDist;
}

void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorldPosition);
    vec3 L = normalize(uSunPosition);

    // Fresnel effect for anime edge glow
    float NdotV = max(0.0, dot(N, V));
    float fresnel = pow(1.0 - NdotV, 3.5);

    // Cel-shaded light stepping (Toon discrete bands)
    float NdotL = dot(N, L);
    float lightBand = smoothstep(-0.1, 0.05, NdotL) * 0.4 + smoothstep(0.15, 0.35, NdotL) * 0.6;

    // Depth color blend based on wave elevation and fresnel
    float depthFactor = clamp((vElevation + 1.2) * 0.5, 0.0, 1.0);
    vec3 waterColor = mix(uWaterDeep, uWaterShallow, depthFactor);
    waterColor = mix(waterColor, uWaterShallow * 1.35, fresnel * 0.7);

    // Foam calculation on wave crests
    float foamThreshold = 0.45;
    float foam = smoothstep(foamThreshold, foamThreshold + 0.15, vElevation);

    // Water caustics & glimmers reactive to treble
    vec2 causticUv = vWorldPosition.xz * 0.35;
    float caust = voronoi(causticUv + vec2(uTime * 0.2));
    float causticLines = smoothstep(0.08, 0.02, caust) * (0.4 + uTreble * 1.2);

    // Anime specular glint (discrete sharp star highlight)
    vec3 H = normalize(L + V);
    float NdotH = max(0.0, dot(N, H));
    float spec = pow(NdotH, 128.0);
    float celSpec = step(0.85, spec);

    vec3 finalColor = mix(waterColor, uWaterFoam, foam * 0.85);
    finalColor += causticLines * uWaterFoam;
    finalColor += celSpec * uSunColor * (1.5 + uTreble * 1.5);
    finalColor *= (0.7 + lightBand * 0.4);

    // Volumetric fog
    float dist = length(cameraPosition - vWorldPosition);
    float fogFactor = 1.0 - exp(-dist * dist * uFogDensity * uFogDensity);
    finalColor = mix(finalColor, uFogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(finalColor, 0.95);
}
`;

// ---------- Foliage Custom Cel Shader ----------
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

    // Wind wave sway with mid-frequency audio reactivity
    float swayAmp = 0.25 + uMid * 0.6;
    float wind = sin(uTime * uWindSpeed + p.x * 0.5 + p.y * 0.8) * cos(uTime * uWindSpeed * 0.7 + p.z * 0.5);
    p.x += wind * swayAmp * (p.y * 0.15);
    p.z += wind * 0.5 * swayAmp * (p.y * 0.15);

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
    // Ghibli style 3-tone discrete cel shading
    float tone = smoothstep(-0.2, 0.05, NdotL) * 0.5 + smoothstep(0.2, 0.4, NdotL) * 0.5;

    vec3 baseColor = mix(uFoliageColor2, uFoliageColor1, tone);
    vec3 litColor = mix(uFoliageShadow, baseColor, tone);

    // Rim lighting (Anime backlight halo)
    float rim = 1.0 - max(0.0, dot(N, V));
    rim = smoothstep(0.65, 0.9, rim) * max(0.0, dot(-L, V) + 0.3);
    litColor += rim * uSunColor * 0.5;

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
	private waterMaterial!: THREE.ShaderMaterial;
	private foliageMaterial!: THREE.ShaderMaterial;
	private particleSystem!: THREE.Points;
	private particleGeo!: THREE.BufferGeometry;
	private particleVelocities!: Float32Array;
	private trees: THREE.Group[] = [];
	private islands: THREE.Mesh[] = [];
	private preset: ScenePreset = "sakura_sunset";
	private clock = new THREE.Clock();
	private running = false;
	private rafId: number | null = null;
	private targetFps = 60;
	private mouseX = 0;
	private mouseY = 0;
	private targetCamX = 0;
	private targetCamY = 8;
	private currentBands: AudioBands = { bass: 0, mid: 0, treble: 0, energy: 0 };
	private resizeObserver: ResizeObserver;

	constructor(container: HTMLElement, preset: ScenePreset = "sakura_sunset") {
		this.container = container;
		this.preset = preset;

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
			opacity: 0;
			transition: opacity 0.8s ease;
		`;
		this.container.appendChild(this.canvas);

		this.scene = new THREE.Scene();
		this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
		this.camera.position.set(0, 7, 24);
		this.camera.lookAt(0, 2, 0);

		this.renderer = new THREE.WebGLRenderer({
			canvas: this.canvas,
			antialias: true,
			alpha: true,
			powerPreference: "high-performance",
		});
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.1;

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

	public setVisible(visible: boolean) {
		this.canvas.style.opacity = visible ? "1" : "0";
		if (visible && !this.running) {
			this.start();
		} else if (!visible && this.running) {
			this.stop();
		}
	}

	public setFpsCap(fps: number) {
		this.targetFps = Math.max(15, Math.min(120, fps));
	}

	private applyPreset(pName: ScenePreset) {
		const theme = PRESETS[pName] || PRESETS.sakura_sunset;

		// Water uniforms
		if (this.waterMaterial) {
			this.waterMaterial.uniforms.uWaterDeep.value.copy(theme.waterDeep);
			this.waterMaterial.uniforms.uWaterShallow.value.copy(theme.waterShallow);
			this.waterMaterial.uniforms.uWaterFoam.value.copy(theme.waterFoam);
			this.waterMaterial.uniforms.uSunColor.value.copy(theme.sunColor);
			this.waterMaterial.uniforms.uFogColor.value.copy(theme.fogColor);
			this.waterMaterial.uniforms.uFogDensity.value = theme.fogDensity;
		}

		// Foliage uniforms
		if (this.foliageMaterial) {
			this.foliageMaterial.uniforms.uFoliageColor1.value.copy(theme.foliageColor1);
			this.foliageMaterial.uniforms.uFoliageColor2.value.copy(theme.foliageColor2);
			this.foliageMaterial.uniforms.uFoliageShadow.value.copy(theme.foliageShadow);
			this.foliageMaterial.uniforms.uSunColor.value.copy(theme.sunColor);
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
		// 1. Water Ocean Plane
		const waterGeo = new THREE.PlaneGeometry(120, 120, 140, 140);
		waterGeo.rotateX(-Math.PI / 2);

		this.waterMaterial = new THREE.ShaderMaterial({
			vertexShader: WaterVertexShader,
			fragmentShader: WaterFragmentShader,
			uniforms: {
				uTime: { value: 0 },
				uBass: { value: 0 },
				uTreble: { value: 0 },
				uWaveSpeed: { value: 1.2 },
				uWaveHeight: { value: 0.75 },
				uWaterDeep: { value: new THREE.Color() },
				uWaterShallow: { value: new THREE.Color() },
				uWaterFoam: { value: new THREE.Color() },
				uSunPosition: { value: new THREE.Vector3(10, 25, -20) },
				uSunColor: { value: new THREE.Color() },
				uFogColor: { value: new THREE.Color() },
				uFogDensity: { value: 0.012 },
			},
			transparent: true,
			wireframe: false,
		});

		const waterMesh = new THREE.Mesh(waterGeo, this.waterMaterial);
		waterMesh.position.y = -0.5;
		this.scene.add(waterMesh);

		// 2. Foliage Material for Anime Trees
		this.foliageMaterial = new THREE.ShaderMaterial({
			vertexShader: FoliageVertexShader,
			fragmentShader: FoliageFragmentShader,
			uniforms: {
				uTime: { value: 0 },
				uMid: { value: 0 },
				uWindSpeed: { value: 1.5 },
				uFoliageColor1: { value: new THREE.Color() },
				uFoliageColor2: { value: new THREE.Color() },
				uFoliageShadow: { value: new THREE.Color() },
				uSunPosition: { value: new THREE.Vector3(10, 25, -20) },
				uSunColor: { value: new THREE.Color() },
				uFogColor: { value: new THREE.Color() },
				uFogDensity: { value: 0.012 },
			},
		});

		// 3. Central & Surrounding Islands with Stylized Trees
		this.createIsland(0, -0.6, -2, 7.5, 2.2);
		this.createIsland(-14, -0.8, -12, 5.5, 1.8);
		this.createIsland(15, -0.8, -10, 6.0, 1.9);

		// Spawn trees on islands
		this.createAnimeTree(0, 1.2, -2, 1.3);
		this.createAnimeTree(-2.8, 0.9, -1.2, 0.95);
		this.createAnimeTree(2.4, 0.8, -3.0, 1.05);
		this.createAnimeTree(-13.5, 0.8, -11.5, 1.1);
		this.createAnimeTree(14.2, 0.9, -9.5, 1.15);

		// 4. Sakura / Ember Floating Particles
		this.createParticles(400);

		// 5. Ambient Celestial Toon Sun/Moon Disk
		const sunGeo = new THREE.SphereGeometry(3.5, 24, 24);
		const sunMat = new THREE.MeshBasicMaterial({ color: 0xfff0dd });
		const sunMesh = new THREE.Mesh(sunGeo, sunMat);
		sunMesh.position.set(10, 25, -50);
		this.scene.add(sunMesh);
	}

	private createIsland(x: number, y: number, z: number, rad: number, height: number) {
		const geo = new THREE.CylinderGeometry(rad * 0.85, rad, height, 16);
		const mat = new THREE.MeshBasicMaterial({ color: 0x1f2937 });
		const island = new THREE.Mesh(geo, mat);
		island.position.set(x, y + height / 2, z);
		this.scene.add(island);
		this.islands.push(island);
	}

	private createAnimeTree(x: number, y: number, z: number, scale: number) {
		const treeGroup = new THREE.Group();
		treeGroup.position.set(x, y, z);
		treeGroup.scale.setScalar(scale);

		// Trunk
		const trunkGeo = new THREE.CylinderGeometry(0.2, 0.45, 3.2, 8);
		const trunkMat = new THREE.MeshBasicMaterial({ color: 0x3d2817 });
		const trunk = new THREE.Mesh(trunkGeo, trunkMat);
		trunk.position.y = 1.6;
		treeGroup.add(trunk);

		// Multi-sphere fluffy Ghibli foliage clusters
		const clusterCoords = [
			[0, 3.6, 0, 1.5],
			[-0.9, 3.2, 0.4, 1.1],
			[0.8, 3.3, -0.3, 1.15],
			[0.2, 4.4, 0.1, 1.2],
			[-0.4, 3.9, -0.7, 1.0],
		];

		for (const [cx, cy, cz, cr] of clusterCoords) {
			const foliageGeo = new THREE.DodecahedronGeometry(cr, 2);
			// Soften vertices for organic clump look
			const pos = foliageGeo.attributes.position;
			for (let i = 0; i < pos.count; i++) {
				const vx = pos.getX(i);
				const vy = pos.getY(i);
				const vz = pos.getZ(i);
				const noise = 1.0 + (Math.sin(vx * 3.0) + Math.cos(vy * 3.0)) * 0.08;
				pos.setXYZ(i, vx * noise, vy * noise, vz * noise);
			}
			foliageGeo.computeVertexNormals();

			const foliageClump = new THREE.Mesh(foliageGeo, this.foliageMaterial);
			foliageClump.position.set(cx, cy, cz);
			treeGroup.add(foliageClump);
		}

		this.scene.add(treeGroup);
		this.trees.push(treeGroup);
	}

	private createParticles(count: number) {
		this.particleGeo = new THREE.BufferGeometry();
		const positions = new Float32Array(count * 3);
		this.particleVelocities = new Float32Array(count * 3);

		for (let i = 0; i < count; i++) {
			positions[i * 3] = (Math.random() - 0.5) * 50;
			positions[i * 3 + 1] = Math.random() * 18 + 0.5;
			positions[i * 3 + 2] = (Math.random() - 0.5) * 50;

			this.particleVelocities[i * 3] = (Math.random() - 0.5) * 0.04;
			this.particleVelocities[i * 3 + 1] = -(Math.random() * 0.03 + 0.01);
			this.particleVelocities[i * 3 + 2] = (Math.random() - 0.5) * 0.04;
		}

		this.particleGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

		const particleMat = new THREE.PointsMaterial({
			size: 0.35,
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

		const delta = this.clock.getDelta();
		const time = this.clock.getElapsedTime();

		// Update shader uniforms
		if (this.waterMaterial) {
			this.waterMaterial.uniforms.uTime.value = time;
		}
		if (this.foliageMaterial) {
			this.foliageMaterial.uniforms.uTime.value = time;
		}

		// Interactive smooth camera parallax tilt
		this.targetCamX = this.mouseX * 3.5;
		this.targetCamY = 6.5 - this.mouseY * 2.0;
		this.camera.position.x += (this.targetCamX - this.camera.position.x) * 0.05;
		this.camera.position.y += (this.targetCamY - this.camera.position.y) * 0.05;
		this.camera.lookAt(0, 2.5, 0);

		// Animate particles (Sakura petals flutter down with gentle turbulence)
		if (this.particleGeo && this.particleVelocities) {
			const posAttr = this.particleGeo.attributes.position;
			const posArr = posAttr.array as Float32Array;
			const count = posArr.length / 3;
			const swirl = 1.0 + this.currentBands.mid * 2.5;

			for (let i = 0; i < count; i++) {
				const idx = i * 3;
				posArr[idx] += (this.particleVelocities[idx] + Math.sin(time + i) * 0.02) * swirl;
				posArr[idx + 1] += this.particleVelocities[idx + 1];
				posArr[idx + 2] += (this.particleVelocities[idx + 2] + Math.cos(time + i) * 0.02) * swirl;

				// Loop reset if dropped below water or drifted out of bounds
				if (posArr[idx + 1] < 0.1 || Math.abs(posArr[idx]) > 28 || Math.abs(posArr[idx + 2]) > 28) {
					posArr[idx] = (Math.random() - 0.5) * 45;
					posArr[idx + 1] = 16 + Math.random() * 4;
					posArr[idx + 2] = (Math.random() - 0.5) * 45;
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
