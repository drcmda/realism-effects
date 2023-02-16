﻿import { Pass } from "postprocessing"
import { HalfFloatType, LinearFilter, Quaternion, Vector3, WebGLRenderTarget } from "three"
import { CopyPass } from "../pass/CopyPass"
import { TemporalResolveMaterial } from "./material/TemporalResolveMaterial"
import { generateR2 } from "./utils/QuasirandomGenerator"

export const defaultTemporalResolvePassOptions = {
	blend: 0.9,
	dilation: false,
	constantBlend: false,
	fullAccumulate: false,
	catmullRomSampling: true,
	renderVelocity: true,
	neighborhoodClamping: false,
	logTransform: false,
	depthDistance: 0.5,
	normalDistance: 10,
	worldDistance: 1,
	reprojectReflectionHitPoints: false,
	customComposeShader: null,
	renderTarget: null
}

export class TemporalResolvePass extends Pass {
	r2Sequence = []
	pointsIndex = 0
	lastCameraTransform = {
		position: new Vector3(),
		quaternion: new Quaternion()
	}

	constructor(scene, camera, velocityPass, options = defaultTemporalResolvePassOptions) {
		super("TemporalResolvePass")

		this._scene = scene
		this._camera = camera
		this.velocityPass = velocityPass
		options = { ...defaultTemporalResolvePassOptions, ...options }

		this.renderTarget =
			options.renderTarget ||
			new WebGLRenderTarget(1, 1, {
				minFilter: LinearFilter,
				magFilter: LinearFilter,
				type: HalfFloatType,
				depthBuffer: false
			})

		this.fullscreenMaterial = new TemporalResolveMaterial()
		if (typeof options.customComposeShader === "string") {
			this.fullscreenMaterial.defines.useCustomComposeShader = ""

			this.fullscreenMaterial.fragmentShader = this.fullscreenMaterial.fragmentShader.replace(
				"customComposeShader",
				options.customComposeShader
			)
		}

		if (options.dilation) this.fullscreenMaterial.defines.dilation = ""
		if (options.neighborhoodClamping) this.fullscreenMaterial.defines.neighborhoodClamping = ""
		if (options.catmullRomSampling) this.fullscreenMaterial.defines.catmullRomSampling = ""
		if (options.logTransform) this.fullscreenMaterial.defines.logTransform = ""
		if (options.reprojectReflectionHitPoints) this.fullscreenMaterial.defines.reprojectReflectionHitPoints = ""

		this.fullscreenMaterial.defines.depthDistance = options.depthDistance.toPrecision(5)
		this.fullscreenMaterial.defines.normalDistance = options.normalDistance.toPrecision(5)
		this.fullscreenMaterial.defines.worldDistance = options.worldDistance.toPrecision(5)

		this.fullscreenMaterial.uniforms.blend.value = options.blend
		this.fullscreenMaterial.uniforms.constantBlend.value = options.constantBlend
		this.fullscreenMaterial.uniforms.fullAccumulate.value = options.fullAccumulate

		this.fullscreenMaterial.uniforms.projectionMatrix.value = camera.projectionMatrix
		this.fullscreenMaterial.uniforms.projectionMatrixInverse.value = camera.projectionMatrixInverse
		this.fullscreenMaterial.uniforms.cameraMatrixWorld.value = camera.matrixWorld
		this.fullscreenMaterial.uniforms.viewMatrix.value = camera.matrixWorldInverse
		this.fullscreenMaterial.uniforms.cameraPos.value = camera.position
		this.fullscreenMaterial.uniforms.prevViewMatrix.value = camera.matrixWorldInverse.clone()
		this.fullscreenMaterial.uniforms.prevCameraMatrixWorld.value = camera.matrixWorld.clone()

		// init copy pass to save the accumulated textures and the textures from the last frame
		this.copyPass = new CopyPass(3)

		this.accumulatedTexture = this.copyPass.renderTarget.texture[0]

		this.accumulatedTexture.type = HalfFloatType
		this.accumulatedTexture.minFilter = LinearFilter
		this.accumulatedTexture.magFilter = LinearFilter
		this.accumulatedTexture.needsUpdate = true

		this.fullscreenMaterial.uniforms.accumulatedTexture.value = this.accumulatedTexture
		this.fullscreenMaterial.uniforms.lastDepthTexture.value = this.copyPass.renderTarget.texture[1]
		this.fullscreenMaterial.uniforms.lastNormalTexture.value = this.copyPass.renderTarget.texture[2]

		this.fullscreenMaterial.uniforms.velocityTexture.value = this.velocityPass.texture
		this.fullscreenMaterial.uniforms.depthTexture.value = this.velocityPass.depthTexture
		this.fullscreenMaterial.uniforms.normalTexture.value = this.velocityPass.normalTexture

		this.renderVelocity = options.renderVelocity

		this.options = options
	}

	get velocityTexture() {
		return this.velocityPass?.texture
	}

	dispose() {
		this.renderTarget.dispose()
		this.copyPass.dispose()
		this.accumulatedTexture.dispose()
		this.fullscreenMaterial.dispose()

		this.velocityPass?.dispose()
	}

	setSize(width, height) {
		this.renderTarget.setSize(width, height)
		this.copyPass.setSize(width, height)
		this.velocityPass?.setSize(width, height)

		this.fullscreenMaterial.uniforms.invTexSize.value.set(1 / width, 1 / height)
	}

	get texture() {
		return this.renderTarget.texture
	}

	render(renderer) {
		if (this.renderVelocity) this.velocityPass.render(renderer)

		renderer.setRenderTarget(this.renderTarget)
		renderer.render(this.scene, this.camera)

		// save the last depth and normal buffers
		this.copyPass.fullscreenMaterial.uniforms.inputTexture.value = this.texture
		this.copyPass.fullscreenMaterial.uniforms.inputTexture2.value = this.fullscreenMaterial.uniforms.depthTexture.value
		this.copyPass.fullscreenMaterial.uniforms.inputTexture3.value = this.fullscreenMaterial.uniforms.normalTexture.value

		this.accumulatedTexture = this.copyPass.fullscreenMaterial.uniforms.inputTexture.value
		this.copyPass.render(renderer)

		// save last transformations
		this.fullscreenMaterial.uniforms.prevCameraMatrixWorld.value.copy(this._camera.matrixWorld)
		this.fullscreenMaterial.uniforms.prevViewMatrix.value.copy(this._camera.matrixWorldInverse)
	}

	jitter(jitterScale = 1) {
		this.unjitter()

		if (this.r2Sequence.length === 0) this.r2Sequence = generateR2(256).map(([a, b]) => [a - 0.5, b - 0.5])

		this.pointsIndex = (this.pointsIndex + 1) % this.r2Sequence.length

		const [x, y] = this.r2Sequence[this.pointsIndex]

		const { width, height } = this.renderTarget

		if (this._camera.setViewOffset)
			this._camera.setViewOffset(width, height, x * jitterScale, y * jitterScale, width, height)
	}

	unjitter() {
		if (this._camera.clearViewOffset) this._camera.clearViewOffset()
	}
}