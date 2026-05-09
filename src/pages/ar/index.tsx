import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import './index.scss'

type ARState = 'loading' | 'scanning' | 'detected' | 'placing' | 'placed' | 'error'

export default function ARPage() {
  const sceneRef = useRef<any>(null)
  const [arState, setArState] = useState<ARState>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    let isMounted = true
    let cleanup: (() => void) | null = null

    const init = async () => {
      try {
        const container = document.getElementById('ar-container')
        if (!container) throw new Error('Container not found')
        container.style.width = window.innerWidth + 'px'
        container.style.height = window.innerHeight + 'px'

        // Load Three.js + MindAR + FBXLoader
        const [THREE, mindArModule] = await Promise.all([
          import('three'),
          import('../../lib/mindar/mindar-image-three.prod.js')
        ])
        if (!isMounted) return

        const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')
        const MindARThree = mindArModule.MindARThree
        if (!MindARThree) throw new Error('MindAR load failed')

        // Pre-load FBX model (reuse for both phases)
        let preloadedFBX: any = null
        const basePath = document.baseURI.replace(/\/[^/]*$/, '/')
        const fbxUrl = basePath + 'assets/ar/test.fbx'
        console.log('[AR] Loading FBX from:', fbxUrl)

        try {
          const loader = new FBXLoader()
          preloadedFBX = await new Promise<any>((resolve, reject) => {
            loader.load(
              fbxUrl,
              (fbx: any) => { console.log('[AR] FBX loaded OK'); resolve(fbx) },
              (progress: any) => { console.log('[AR] FBX loading...', progress.loaded) },
              (err: any) => { console.error('[AR] FBX load error:', err); reject(err) }
            )
          })
          // Remove animations
          if (preloadedFBX.animations) preloadedFBX.animations = []
        } catch (e: any) {
          console.warn('[AR] FBX load failed, using fallback box:', e.message)
          preloadedFBX = null
        }

        // ===== Phase 1: MindAR image recognition =====
        const mindarThree = new MindARThree({
          container,
          imageTargetSrc: basePath + 'assets/ar/card.mind',
          uiLoading: 'no', uiScanning: 'no', uiError: 'no',
        })

        const { renderer, scene, camera } = mindarThree
        const anchor = mindarThree.addAnchor(0)

        // Simple lighting for preview
        scene.add(new THREE.AmbientLight(0xffffff, 1.0))
        const dl = new THREE.DirectionalLight(0xffffff, 0.8)
        dl.position.set(1, 2, 1)
        scene.add(dl)

        // Create preview model on anchor
        let modelGroup: any
        if (preloadedFBX) {
          const previewFBX = preloadedFBX.clone()
          const box = new THREE.Box3().setFromObject(previewFBX)
          const size = box.getSize(new THREE.Vector3())
          const maxDim = Math.max(size.x, size.y, size.z)
          const scale = 0.5 / maxDim
          previewFBX.scale.setScalar(scale)
          // Center on anchor
          const newBox = new THREE.Box3().setFromObject(previewFBX)
          const center = newBox.getCenter(new THREE.Vector3())
          previewFBX.position.sub(center)
          modelGroup = new THREE.Group()
          modelGroup.add(previewFBX)
        } else {
          // Fallback: colored box
          modelGroup = new THREE.Mesh(
            new THREE.BoxGeometry(0.3, 0.3, 0.3),
            new THREE.MeshStandardMaterial({ color: 0x6366f1 })
          )
        }

        modelGroup.visible = false
        anchor.group.add(modelGroup)

        anchor.onTargetFound = () => {
          if (!isMounted) return
          console.log('[AR] Target found - showing preview')
          modelGroup.visible = true
          setArState('detected')
        }
        anchor.onTargetLost = () => {
          if (!isMounted) return
          modelGroup.visible = false
          setArState('scanning')
        }

        await mindarThree.start()
        if (!isMounted) return

        // Ensure video is visible
        const video = container.querySelector('video')
        if (video) video.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;'

        setArState('scanning')

        let animId = 0
        const animate = () => {
          renderer.render(scene, camera)
          animId = requestAnimationFrame(animate)
        }
        animate()

        sceneRef.current = {
          THREE, container, FBXLoader, preloadedFBX, fbxUrl,
          stop: () => { cancelAnimationFrame(animId); try { mindarThree.stop() } catch (e) {} }
        }
        cleanup = sceneRef.current.stop
      } catch (err: any) {
        console.error('[AR] Init error:', err)
        if (isMounted) { setArState('error'); setError(err.message || '初始化失败') }
      }
    }

    init()
    return () => { isMounted = false; if (cleanup) cleanup() }
  }, [])

  // ===== Enter WebXR =====
  const placeModel = async () => {
    const ref = sceneRef.current
    if (!ref) return

    if (!navigator.xr) {
      setError('浏览器不支持WebXR，请使用Android Chrome')
      setArState('error')
      return
    }
    const supported = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false)
    if (!supported) {
      setError('设备不支持AR，需要Android Chrome + ARCore')
      setArState('error')
      return
    }

    ref.stop()
    const container = ref.container as HTMLElement
    container.innerHTML = ''

    setArState('placing')
    await startWebXR(ref.THREE, ref.FBXLoader, container, ref.preloadedFBX, ref.fbxUrl)
  }

  // ===== WebXR with hit-test + depth occlusion =====
  const startWebXR = async (THREE: any, FBXLoaderClass: any, container: HTMLElement, preloadedFBX: any, fbxUrl: string) => {
    const w = window.innerWidth, h = window.innerHeight

    // === Renderer (NO shadows) ===
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.xr.enabled = true
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;'
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(70, w / h, 0.01, 100)

    // === Lighting (no shadows) ===
    scene.add(new THREE.AmbientLight(0xffffff, 0.8))
    const mainLight = new THREE.DirectionalLight(0xffffff, 1.2)
    mainLight.position.set(0.5, 3, 1)
    scene.add(mainLight)
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
    fillLight.position.set(-1, 1, -1)
    scene.add(fillLight)

    // === Load/Clone FBX Model ===
    let model: any
    try {
      let fbx: any
      if (preloadedFBX) {
        fbx = preloadedFBX.clone()
        console.log('[WebXR] Using preloaded FBX clone')
      } else {
        console.log('[WebXR] Loading FBX fresh from:', fbxUrl)
        const loader = new FBXLoaderClass()
        fbx = await new Promise<any>((resolve, reject) => {
          loader.load(fbxUrl, resolve, undefined, reject)
        })
        fbx.animations = []
      }

      const box = new THREE.Box3().setFromObject(fbx)
      const size = box.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z)
      const scale = 0.4 / maxDim
      fbx.scale.setScalar(scale)
      // Bottom at y=0 (sits on surface)
      const newBox = new THREE.Box3().setFromObject(fbx)
      fbx.position.y -= newBox.min.y

      model = new THREE.Group()
      model.add(fbx)
      console.log('[WebXR] Model ready, scale:', scale)
    } catch (e: any) {
      console.error('[WebXR] Model load failed:', e)
      model = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.2, 0.2),
        new THREE.MeshStandardMaterial({ color: 0x6366f1 })
      )
      model.position.y = 0.1
    }

    model.visible = false
    scene.add(model)

    // === Reticle (placement indicator) ===
    const reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.08, 0.1, 32),
      new THREE.MeshBasicMaterial({ color: 0x22c55e, side: THREE.DoubleSide })
    )
    reticle.rotation.x = -Math.PI / 2
    reticle.visible = false
    scene.add(reticle)

    // === Depth Occlusion Quad (renders first, writes depth only) ===
    const depthOcclusionMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uDepthTexture: { value: null },
        uRawValueToMeters: { value: 0.001 },
        uUvTransform: { value: new THREE.Matrix4() },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = position.xy * 0.5 + 0.5;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uDepthTexture;
        uniform float uRawValueToMeters;
        uniform mat4 uUvTransform;
        varying vec2 vUv;

        void main() {
          // Transform UV using depth normalization matrix
          vec4 tUv = uUvTransform * vec4(vUv, 0.0, 1.0);
          vec2 depthUv = tUv.xy;

          // Sample depth (luminance-alpha: low byte=r, high byte=g)
          vec4 d = texture2D(uDepthTexture, depthUv);
          float depthM = (d.r * 255.0 + d.g * 255.0 * 256.0) * uRawValueToMeters;

          // Discard invalid depth
          if (depthM < 0.1 || depthM > 15.0) discard;

          // Convert to normalized device depth [0,1]
          // Perspective depth: z_ndc = (f*(z-n)) / (z*(f-n))
          float near = 0.01;
          float far = 100.0;
          float ndcZ = (far * (depthM - near)) / (depthM * (far - near));
          gl_FragDepth = ndcZ;
          gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        }
      `,
      depthWrite: true,
      depthTest: false,
      transparent: true,
      side: THREE.DoubleSide,
    })
    depthOcclusionMaterial.colorWrite = false

    const occlusionQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      depthOcclusionMaterial
    )
    occlusionQuad.frustumCulled = false
    occlusionQuad.renderOrder = -1 // Render before everything
    occlusionQuad.visible = false // Hidden until depth is available
    scene.add(occlusionQuad)

    // === Depth Data Texture (for CPU depth upload) ===
    let depthDataTexture: any = null
    let depthEnabled = false

    // === Start WebXR Session ===
    const overlayEl = document.getElementById('ar-overlay')
    const sessionInit: any = {
      requiredFeatures: ['hit-test', 'local-floor'],
      optionalFeatures: ['dom-overlay', 'depth-sensing'],
      depthSensing: {
        usagePreference: ['cpu-optimized'],
        dataFormatPreference: ['luminance-alpha', 'float32']
      }
    }
    if (overlayEl) {
      sessionInit.domOverlay = { root: overlayEl }
    }

    try {
      const session = await navigator.xr!.requestSession('immersive-ar', sessionInit)

      // Check if depth-sensing is available
      if ((session as any).depthUsage) {
        depthEnabled = true
        console.log('[WebXR] Depth sensing enabled:', (session as any).depthUsage, (session as any).depthDataFormat)
      } else {
        console.log('[WebXR] Depth sensing NOT available - no occlusion')
      }

      renderer.xr.setReferenceSpaceType('local-floor')
      await renderer.xr.setSession(session)

      // Reference spaces
      const refSpace = await session.requestReferenceSpace('local-floor')
      const viewerSpace = await session.requestReferenceSpace('viewer')
      const hitTestSource = await (session as any).requestHitTestSource!({ space: viewerSpace })

      let modelPlaced = false

      // Tap to place model
      session.addEventListener('select', () => {
        if (modelPlaced) return
        if (reticle.visible) {
          model.position.copy(reticle.position)
          model.visible = true
          reticle.visible = false
          modelPlaced = true
          setArState('placed')
          console.log('[WebXR] Model placed at:', model.position.toArray())
        }
      })

      // === Render Loop ===
      renderer.setAnimationLoop((timestamp: number, frame: any) => {
        if (!frame) { renderer.render(scene, camera); return }

        // --- Depth Occlusion Update ---
        if (depthEnabled && modelPlaced) {
          try {
            const pose = frame.getViewerPose(refSpace)
            if (pose && pose.views.length > 0) {
              const view = pose.views[0]
              const depthInfo = frame.getDepthInformation(view)
              if (depthInfo) {
                updateDepthOcclusion(THREE, depthInfo, depthOcclusionMaterial, occlusionQuad)
              }
            }
          } catch (e) {
            // Depth not available this frame, skip
          }
        }

        // --- Hit-test for reticle ---
        if (!modelPlaced) {
          const hitTestResults = frame.getHitTestResults(hitTestSource)
          if (hitTestResults.length > 0) {
            const hit = hitTestResults[0]
            const pose = hit.getPose(refSpace)
            if (pose) {
              reticle.visible = true
              reticle.position.set(
                pose.transform.position.x,
                pose.transform.position.y,
                pose.transform.position.z
              )
              reticle.quaternion.set(
                pose.transform.orientation.x,
                pose.transform.orientation.y,
                pose.transform.orientation.z,
                pose.transform.orientation.w
              )
            }
          } else {
            reticle.visible = false
          }
        }

        renderer.render(scene, camera)
      })

      session.addEventListener('end', () => {
        renderer.setAnimationLoop(null)
        try { hitTestSource?.cancel() } catch (e) {}
      })

      sceneRef.current = {
        stop: () => {
          try { hitTestSource?.cancel() } catch (e) {}
          try { session.end() } catch (e) {}
          renderer.dispose()
        }
      }
    } catch (err: any) {
      console.error('[WebXR] Session error:', err)
      setError('WebXR启动失败: ' + err.message)
      setArState('error')
    }
  }

  // === Depth Occlusion Updater ===
  const depthTextureRef = useRef<any>(null)

  function updateDepthOcclusion(THREE: any, depthInfo: any, material: any, quad: any) {
    const { width, height, data, rawValueToMeters } = depthInfo

    // Create or resize DataTexture
    if (!depthTextureRef.current || depthTextureRef.current.image.width !== width || depthTextureRef.current.image.height !== height) {
      if (depthTextureRef.current) depthTextureRef.current.dispose()
      // luminance-alpha data: 2 bytes per pixel → store as RG texture
      depthTextureRef.current = new THREE.DataTexture(
        new Uint8Array(width * height * 2),
        width, height,
        THREE.RGFormat,
        THREE.UnsignedByteType
      )
      depthTextureRef.current.minFilter = THREE.NearestFilter
      depthTextureRef.current.magFilter = THREE.NearestFilter
      depthTextureRef.current.wrapS = THREE.ClampToEdgeWrapping
      depthTextureRef.current.wrapT = THREE.ClampToEdgeWrapping
      console.log('[Depth] Created depth texture:', width, 'x', height)
    }

    // Upload raw depth bytes
    const tex = depthTextureRef.current
    const srcArray = new Uint8Array(data)
    tex.image.data.set(srcArray)
    tex.needsUpdate = true

    // Update shader uniforms
    material.uniforms.uDepthTexture.value = tex
    material.uniforms.uRawValueToMeters.value = rawValueToMeters

    // UV transform from depth info
    if (depthInfo.normDepthBufferFromNormView) {
      const m = depthInfo.normDepthBufferFromNormView.matrix
      material.uniforms.uUvTransform.value.fromArray(m)
    }

    quad.visible = true
  }

  const rescan = () => {
    if (sceneRef.current) { sceneRef.current.stop(); sceneRef.current = null }
    window.location.reload()
  }

  const goBack = () => {
    if (sceneRef.current) sceneRef.current.stop()
    Taro.navigateBack()
  }

  return (
    <div className="ar-page">
      <div id="ar-container" className="ar-container" />
      <div id="ar-overlay" className="ar-overlay">

        {arState === 'loading' && (
          <div className="ar-loading-overlay">
            <div className="ar-loading-spinner" />
            <span className="ar-loading-text">正在启动...</span>
          </div>
        )}

        {arState === 'scanning' && (
          <div className="ar-viewfinder">
            <div className="viewfinder-frame">
              <div className="frame-corner top-left" />
              <div className="frame-corner top-right" />
              <div className="frame-corner bottom-left" />
              <div className="frame-corner bottom-right" />
            </div>
            <span className="viewfinder-text">对准识别图</span>
          </div>
        )}

        {arState === 'detected' && (
          <div className="ar-detected-overlay">
            <div className="detected-info">识别成功 · 模型预览中</div>
            <div className="place-btn" onClick={placeModel}>
              <span>进入AR空间</span>
            </div>
          </div>
        )}

        {arState === 'placing' && (
          <div className="ar-placing-hint">
            <span>缓慢移动手机扫描地面 · 点击放置模型</span>
          </div>
        )}

        <div className="ar-topbar">
          <div className="ar-back-btn" onClick={goBack}>←</div>
          {arState === 'placed' && (
            <div className="ar-locked-badge">已锚定 · 真实深度遮挡</div>
          )}
        </div>

        {arState === 'placed' && (
          <div className="ar-bottom">
            <div className="rescan-btn" onClick={rescan}><span>重新放置</span></div>
          </div>
        )}

        {arState === 'error' && (
          <div className="ar-error">
            <span className="error-text">{error}</span>
            <div className="error-btn" onClick={goBack}>返回</div>
          </div>
        )}
      </div>
    </div>
  )
}
