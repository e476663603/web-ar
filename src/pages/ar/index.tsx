import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import './index.scss'

type ARState = 'loading' | 'scanning' | 'detected' | 'placing' | 'placed' | 'error'

export default function ARPage() {
  const sceneRef = useRef<any>(null)
  const [arState, setArState] = useState<ARState>('loading')
  const [error, setError] = useState('')
  const depthTextureRef = useRef<any>(null)

  useEffect(() => {
    let isMounted = true
    let cleanup: (() => void) | null = null

    const init = async () => {
      try {
        const container = document.getElementById('ar-container')
        if (!container) throw new Error('Container not found')
        container.style.width = window.innerWidth + 'px'
        container.style.height = window.innerHeight + 'px'

        console.log('[AR] Starting init...')

        // === Dynamic imports with timeout ===
        const importPromise = Promise.all([
          import('three'),
          import('../../lib/mindar/mindar-image-three.prod.js'),
          import('three/examples/jsm/loaders/FBXLoader.js')
        ])
        const importTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('模块加载超时，请检查网络后刷新')), 20000)
        )
        const [THREE, mindArModule, fbxModule] = await Promise.race([importPromise, importTimeout]) as any[]
        if (!isMounted) return
        console.log('[AR] Modules loaded')

        const { FBXLoader } = fbxModule
        const MindARThree = mindArModule.MindARThree
        if (!MindARThree) throw new Error('MindAR模块加载失败，请刷新')

        // === Create MindAR (DO NOT pre-load FBX here to avoid blocking) ===
        const mindarThree = new MindARThree({
          container,
          imageTargetSrc: './assets/ar/card.mind',
          uiLoading: 'no', uiScanning: 'no', uiError: 'no',
        })

        const { renderer, scene, camera } = mindarThree
        const anchor = mindarThree.addAnchor(0)

        // Lighting
        scene.add(new THREE.AmbientLight(0xffffff, 1.0))
        const dl = new THREE.DirectionalLight(0xffffff, 0.8)
        dl.position.set(1, 2, 1)
        scene.add(dl)

        // Placeholder group for model on anchor
        const modelGroup = new THREE.Group()
        modelGroup.visible = false
        anchor.group.add(modelGroup)

        // Target callbacks
        anchor.onTargetFound = () => {
          if (!isMounted) return
          console.log('[AR] Target FOUND')
          modelGroup.visible = true
          setArState('detected')
        }
        anchor.onTargetLost = () => {
          if (!isMounted) return
          console.log('[AR] Target LOST')
          modelGroup.visible = false
          setArState('scanning')
        }

        // === Start MindAR first (opens camera immediately) ===
        console.log('[AR] Starting MindAR...')
        const startTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('AR相机启动超时(15s)，请刷新重试')), 15000)
        )
        await Promise.race([mindarThree.start(), startTimeout])
        if (!isMounted) return
        console.log('[AR] MindAR started OK - camera open')

        // Ensure video visible
        const video = container.querySelector('video')
        if (video) {
          video.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;'
        }

        setArState('scanning')

        // Start render loop immediately
        let animId = 0
        const animate = () => {
          renderer.render(scene, camera)
          animId = requestAnimationFrame(animate)
        }
        animate()

        // === Load FBX in background (non-blocking) ===
        let preloadedFBX: any = null
        const loadFBX = async () => {
          try {
            console.log('[AR] Loading FBX in background...')
            const loader = new FBXLoader()
            const fbx: any = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('FBX timeout')), 10000)
              loader.load(
                './assets/ar/test.fbx',
                (obj: any) => { clearTimeout(timer); resolve(obj) },
                undefined,
                (err: any) => { clearTimeout(timer); reject(err) }
              )
            })
            console.log('[AR] FBX loaded OK')
            fbx.animations = []
            // Scale and center for preview
            const box = new THREE.Box3().setFromObject(fbx)
            const size = box.getSize(new THREE.Vector3())
            const maxDim = Math.max(size.x, size.y, size.z)
            const scale = 0.5 / maxDim
            fbx.scale.setScalar(scale)
            const newBox = new THREE.Box3().setFromObject(fbx)
            const center = newBox.getCenter(new THREE.Vector3())
            fbx.position.sub(center)
            modelGroup.add(fbx)
            preloadedFBX = fbx
          } catch (e: any) {
            console.warn('[AR] FBX failed, using fallback:', e.message)
            const box = new THREE.Mesh(
              new THREE.BoxGeometry(0.3, 0.3, 0.3),
              new THREE.MeshStandardMaterial({ color: 0x6366f1 })
            )
            modelGroup.add(box)
            preloadedFBX = box
          }
        }
        loadFBX() // Non-blocking

        // Store refs
        sceneRef.current = {
          THREE, container, FBXLoader,
          getPreloaded: () => preloadedFBX,
          stop: () => {
            cancelAnimationFrame(animId)
            try { mindarThree.stop() } catch (e) {}
          }
        }
        cleanup = sceneRef.current.stop

      } catch (err: any) {
        console.error('[AR] Init error:', err)
        if (isMounted) {
          setArState('error')
          setError(err.message || '初始化失败')
        }
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
    await startWebXR(ref.THREE, ref.FBXLoader, container, ref.getPreloaded())
  }

  // ===== WebXR with hit-test + depth occlusion =====
  const startWebXR = async (THREE: any, FBXLoaderClass: any, container: HTMLElement, preloadedFBX: any) => {
    const w = window.innerWidth, h = window.innerHeight

    // Renderer
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.xr.enabled = true
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;'
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(70, w / h, 0.01, 100)

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.8))
    const mainLight = new THREE.DirectionalLight(0xffffff, 1.2)
    mainLight.position.set(0.5, 3, 1)
    scene.add(mainLight)
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
    fillLight.position.set(-1, 1, -1)
    scene.add(fillLight)

    // === Model ===
    let model: any
    try {
      let fbx: any
      if (preloadedFBX) {
        fbx = preloadedFBX.clone()
        console.log('[WebXR] Using preloaded model')
      } else {
        console.log('[WebXR] Loading FBX fresh...')
        const loader = new FBXLoaderClass()
        fbx = await new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), 10000)
          loader.load(
            './assets/ar/test.fbx',
            (obj: any) => { clearTimeout(timer); resolve(obj) },
            undefined,
            (err: any) => { clearTimeout(timer); reject(err) }
          )
        })
        fbx.animations = []
      }
      const box = new THREE.Box3().setFromObject(fbx)
      const size = box.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z)
      const scale = 0.4 / maxDim
      fbx.scale.setScalar(scale)
      const newBox = new THREE.Box3().setFromObject(fbx)
      fbx.position.y -= newBox.min.y
      model = new THREE.Group()
      model.add(fbx)
    } catch (e: any) {
      console.error('[WebXR] Model failed:', e)
      model = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.2, 0.2),
        new THREE.MeshStandardMaterial({ color: 0x6366f1 })
      )
      model.position.y = 0.1
    }
    model.visible = false
    scene.add(model)

    // No reticle needed - auto-place

    // === Depth Occlusion Shader ===
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
          vec4 tUv = uUvTransform * vec4(vUv, 0.0, 1.0);
          vec2 depthUv = tUv.xy;
          vec4 d = texture2D(uDepthTexture, depthUv);
          float depthM = (d.r * 255.0 + d.g * 255.0 * 256.0) * uRawValueToMeters;
          if (depthM < 0.1 || depthM > 20.0) discard;
          float near = 0.01;
          float far = 100.0;
          float ndcZ = (far * (depthM - near)) / (depthM * (far - near));
          gl_FragDepth = ndcZ;
          gl_FragColor = vec4(0.0);
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
    occlusionQuad.renderOrder = -1
    occlusionQuad.visible = false
    scene.add(occlusionQuad)

    // === Start WebXR Session ===
    const overlayEl = document.getElementById('ar-overlay')
    const sessionInit: any = {
      requiredFeatures: ['hit-test', 'local-floor'],
      optionalFeatures: ['dom-overlay', 'depth-sensing', 'anchors'],
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

      let depthEnabled = false
      if ((session as any).depthUsage) {
        depthEnabled = true
        console.log('[WebXR] Depth occlusion enabled')
      } else {
        console.log('[WebXR] Depth NOT available')
      }

      renderer.xr.setReferenceSpaceType('local-floor')
      await renderer.xr.setSession(session)

      // Use viewer space for hit-test ray (center of screen)
      const viewerSpace = await session.requestReferenceSpace('viewer')
      const hitTestSource = await (session as any).requestHitTestSource!({ space: viewerSpace })

      let modelPlaced = false
      let hitCount = 0
      let xrAnchor: any = null // XR Anchor for persistent tracking

      // === Auto-place with XR Anchor ===
      const placeWithAnchor = async (hitResult: any, frame: any) => {
        if (modelPlaced) return
        modelPlaced = true
        setArState('placed')

        // Get Three.js's internal reference space (same coord system as rendering)
        const threeRefSpace = renderer.xr.getReferenceSpace()
        const pose = hitResult.getPose(threeRefSpace)

        if (pose) {
          model.position.set(
            pose.transform.position.x,
            pose.transform.position.y,
            pose.transform.position.z
          )
          model.quaternion.set(
            pose.transform.orientation.x,
            pose.transform.orientation.y,
            pose.transform.orientation.z,
            pose.transform.orientation.w
          )
        }
        model.visible = true

        // Create XR Anchor for persistent world-locked tracking
        try {
          if (hitResult.createAnchor) {
            xrAnchor = await hitResult.createAnchor()
            console.log('[WebXR] XR Anchor created from hit-test!')
          } else if (frame.createAnchor && pose) {
            xrAnchor = await frame.createAnchor(pose.transform, threeRefSpace)
            console.log('[WebXR] XR Anchor created from frame!')
          }
        } catch (e) {
          console.warn('[WebXR] Anchor creation failed, using static position')
        }

        console.log('[WebXR] Model placed, anchor:', !!xrAnchor)
      }

      // Fallback: place at default position if no surface found
      const fallbackTimer = setTimeout(() => {
        if (!modelPlaced) {
          modelPlaced = true
          setArState('placed')
          // Place 1.5m in front, at approximate floor level
          model.position.set(0, -1.0, -1.5)
          model.visible = true
          console.log('[WebXR] Fallback placement (no surface found)')
        }
      }, 5000)

      // === Render Loop ===
      renderer.setAnimationLoop((timestamp: number, frame: any) => {
        if (!frame) { renderer.render(scene, camera); return }

        // Get Three.js's reference space each frame (guaranteed correct coord system)
        const threeRefSpace = renderer.xr.getReferenceSpace()

        // --- Update model position from XR Anchor (if available) ---
        if (xrAnchor && threeRefSpace) {
          try {
            const anchorPose = frame.getPose(xrAnchor.anchorSpace, threeRefSpace)
            if (anchorPose) {
              model.position.set(
                anchorPose.transform.position.x,
                anchorPose.transform.position.y,
                anchorPose.transform.position.z
              )
              model.quaternion.set(
                anchorPose.transform.orientation.x,
                anchorPose.transform.orientation.y,
                anchorPose.transform.orientation.z,
                anchorPose.transform.orientation.w
              )
            }
          } catch (e) { /* anchor pose unavailable this frame */ }
        }

        // --- Depth occlusion ---
        if (depthEnabled && modelPlaced && threeRefSpace) {
          try {
            const viewerPose = frame.getViewerPose(threeRefSpace)
            if (viewerPose && viewerPose.views.length > 0) {
              const depthInfo = frame.getDepthInformation(viewerPose.views[0])
              if (depthInfo) {
                updateDepthOcclusion(THREE, depthInfo, depthOcclusionMaterial, occlusionQuad)
              }
            }
          } catch (e) { /* skip */ }
        }

        // --- Auto-place on first stable hit ---
        if (!modelPlaced) {
          try {
            const hits = frame.getHitTestResults(hitTestSource)
            if (hits.length > 0) {
              hitCount++
              if (hitCount >= 3) {
                clearTimeout(fallbackTimer)
                placeWithAnchor(hits[0], frame)
                try { hitTestSource.cancel() } catch (e) {}
              }
            }
          } catch (e) { /* skip */ }
        }

        renderer.render(scene, camera)
      })

      session.addEventListener('end', () => {
        renderer.setAnimationLoop(null)
        clearTimeout(fallbackTimer)
        try { hitTestSource?.cancel() } catch (e) {}
        if (xrAnchor) { try { xrAnchor.delete() } catch (e) {} }
      })

      sceneRef.current = {
        stop: () => {
          clearTimeout(fallbackTimer)
          try { hitTestSource?.cancel() } catch (e) {}
          if (xrAnchor) { try { xrAnchor.delete() } catch (e) {} }
          try { session.end() } catch (e) {}
          renderer.dispose()
        }
      }
    } catch (err: any) {
      console.error('[WebXR] Error:', err)
      setError('WebXR启动失败: ' + err.message)
      setArState('error')
    }
  }

  // Depth updater
  function updateDepthOcclusion(THREE: any, depthInfo: any, material: any, quad: any) {
    const { width, height, data, rawValueToMeters } = depthInfo
    if (!depthTextureRef.current || depthTextureRef.current.image.width !== width) {
      if (depthTextureRef.current) depthTextureRef.current.dispose()
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
      console.log('[Depth] Tex:', width, 'x', height)
    }
    const tex = depthTextureRef.current
    tex.image.data.set(new Uint8Array(data))
    tex.needsUpdate = true
    material.uniforms.uDepthTexture.value = tex
    material.uniforms.uRawValueToMeters.value = rawValueToMeters
    if (depthInfo.normDepthBufferFromNormView) {
      material.uniforms.uUvTransform.value.fromArray(depthInfo.normDepthBufferFromNormView.matrix)
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
            <span className="ar-loading-text">正在启动相机...</span>
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
            <div className="ar-loading-spinner" style={{ width: '20px', height: '20px', marginBottom: '8px' }} />
            <span>正在检测环境，请缓慢移动手机...</span>
          </div>
        )}

        <div className="ar-topbar">
          <div className="ar-back-btn" onClick={goBack}>←</div>
          {arState === 'placed' && (
            <div className="ar-locked-badge">已锚定 · 自由走动查看</div>
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
            <div className="error-btn" onClick={() => window.location.reload()}>刷新重试</div>
            <div className="error-btn" onClick={goBack} style={{ marginTop: '8px', background: 'transparent', border: '1px solid rgba(255,255,255,0.3)' }}>返回</div>
          </div>
        )}
      </div>
    </div>
  )
}
