import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import './index.scss'

type ARState = 'loading' | 'scanning' | 'detected' | 'placing' | 'placed' | 'error'

export default function ARPage() {
  const sceneRef = useRef<any>(null)
  const [arState, setArState] = useState<ARState>('loading')
  const [error, setError] = useState('')
  const [edgeWarning, setEdgeWarning] = useState<string>('')
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

        const mindarThree = new MindARThree({
          container,
          imageTargetSrc: './assets/ar/card.mind',
          uiLoading: 'no', uiScanning: 'no', uiError: 'no',
        })

        const { renderer, scene, camera } = mindarThree
        const anchor = mindarThree.addAnchor(0)

        scene.add(new THREE.AmbientLight(0xffffff, 1.0))
        const dl = new THREE.DirectionalLight(0xffffff, 0.8)
        dl.position.set(1, 2, 1)
        scene.add(dl)

        const modelGroup = new THREE.Group()
        modelGroup.visible = false
        anchor.group.add(modelGroup)

        anchor.onTargetFound = () => {
          if (!isMounted) return
          modelGroup.visible = true
          setArState('detected')
        }
        anchor.onTargetLost = () => {
          if (!isMounted) return
          modelGroup.visible = false
          setArState('scanning')
        }

        console.log('[AR] Starting MindAR...')
        const startTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('AR相机启动超时(15s)，请刷新重试')), 15000)
        )
        await Promise.race([mindarThree.start(), startTimeout])
        if (!isMounted) return

        const video = container.querySelector('video')
        if (video) {
          video.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;'
        }

        setArState('scanning')

        let animId = 0
        const animate = () => {
          renderer.render(scene, camera)
          animId = requestAnimationFrame(animate)
        }
        animate()

        let preloadedFBX: any = null
        const loadFBX = async () => {
          try {
            const loader = new FBXLoader()
            const fbx: any = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('FBX timeout')), 10000)
              loader.load('./assets/ar/test.fbx',
                (obj: any) => { clearTimeout(timer); resolve(obj) },
                undefined,
                (err: any) => { clearTimeout(timer); reject(err) }
              )
            })
            fbx.animations = []
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
            const box = new THREE.Mesh(
              new THREE.BoxGeometry(0.3, 0.3, 0.3),
              new THREE.MeshStandardMaterial({ color: 0x6366f1 })
            )
            modelGroup.add(box)
            preloadedFBX = box
          }
        }
        loadFBX()

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

  // ===== WebXR: Drag-to-place + Depth Occlusion =====
  const startWebXR = async (THREE: any, FBXLoaderClass: any, container: HTMLElement, preloadedFBX: any) => {
    const w = window.innerWidth, h = window.innerHeight

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
      } else {
        const loader = new FBXLoaderClass()
        fbx = await new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), 10000)
          loader.load('./assets/ar/test.fbx',
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
      model = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.2, 0.2),
        new THREE.MeshStandardMaterial({ color: 0x6366f1 })
      )
      model.position.y = 0.1
    }
    model.visible = false
    scene.add(model)

    // === Placement indicator: 3D pillar + ground disc (visible from any angle) ===
    const indicatorGroup = new THREE.Group()
    indicatorGroup.visible = false

    // Ground disc
    const discGeo = new THREE.CircleGeometry(0.2, 48)
    const discMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
    const disc = new THREE.Mesh(discGeo, discMat)
    disc.rotation.x = -Math.PI / 2
    disc.position.y = 0.003
    indicatorGroup.add(disc)

    // Ring around disc
    const ringGeo = new THREE.RingGeometry(0.18, 0.25, 48)
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
    const placementRing = new THREE.Mesh(ringGeo, ringMat)
    placementRing.rotation.x = -Math.PI / 2
    placementRing.position.y = 0.005
    indicatorGroup.add(placementRing)

    // Vertical pillar (always visible from side view)
    const pillarGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.5, 8)
    const pillarMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.6 })
    const pillar = new THREE.Mesh(pillarGeo, pillarMat)
    pillar.position.y = 0.25
    indicatorGroup.add(pillar)

    // Top sphere marker
    const topSphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.9 })
    )
    topSphere.position.y = 0.52
    indicatorGroup.add(topSphere)

    scene.add(indicatorGroup)

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

    // === WebXR Session ===
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
      }

      renderer.xr.setReferenceSpaceType('local-floor')
      await renderer.xr.setSession(session)

      const viewerSpace = await session.requestReferenceSpace('viewer')
      const hitTestSource = await (session as any).requestHitTestSource!({ space: viewerSpace })

      // === Drag State ===
      let modelPlaced = false
      let isDragging = false
      let dragTouchPos = { x: w / 2, y: h / 2 }
      let placingAnchor: any = null // Anchor during placing phase
      let anchorUpdatePending = false
      const raycaster = new THREE.Raycaster()
      const ndcVec = new THREE.Vector2()
      const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
      const intersectPoint = new THREE.Vector3()

      // Store latest frame for anchor creation
      let frameRef: any = null

      // Model starts at default position
      model.position.set(0, 0, -1.5)
      model.visible = true
      indicatorGroup.position.set(0, 0, -1.5)
      indicatorGroup.visible = true

      // === Create anchor at model position ===
      const createAnchorAt = async (x: number, y: number, z: number) => {
        const threeRefSpace = renderer.xr.getReferenceSpace()
        if (!threeRefSpace || !frameRef) return null
        try {
          const anchorPose = new XRRigidTransform(
            new DOMPoint(x, y, z, 1),
            new DOMPoint(0, 0, 0, 1)
          )
          const anchor = await frameRef.createAnchor(anchorPose, threeRefSpace)
          console.log('[WebXR] Anchor created at:', x.toFixed(2), y.toFixed(2), z.toFixed(2))
          return anchor
        } catch (e) {
          console.warn('[WebXR] Anchor creation failed:', e)
          return null
        }
      }

      // Delete old anchor and create new one
      const reAnchor = async (x: number, y: number, z: number) => {
        if (placingAnchor) {
          try { placingAnchor.delete() } catch (e) {}
        }
        placingAnchor = await createAnchorAt(x, y, z)
      }

      // === Touch Handlers ===
      const onTouchStart = (e: TouchEvent) => {
        if (modelPlaced) return
        // Don't start drag if touching UI buttons
        const target = e.target as HTMLElement
        if (target.closest('.confirm-place-btn, .ar-back-btn, .rescan-btn')) return
        e.preventDefault()
        isDragging = true
        const touch = e.touches[0]
        dragTouchPos = { x: touch.clientX, y: touch.clientY }
        ringMat.color.set(0x22c55e) // Green while dragging
        discMat.color.set(0x22c55e)
        pillarMat.color.set(0x22c55e)
        topSphere.material.color.set(0x22c55e)
        ringMat.opacity = 1.0
        discMat.opacity = 0.6
      }

      const onTouchMove = (e: TouchEvent) => {
        if (!isDragging || modelPlaced) return
        e.preventDefault()
        const touch = e.touches[0]
        dragTouchPos = { x: touch.clientX, y: touch.clientY }
      }

      const onTouchEnd = (e: TouchEvent) => {
        if (!isDragging || modelPlaced) return
        isDragging = false
        anchorUpdatePending = true
        ringMat.color.set(0xfbbf24) // Yellow idle
        discMat.color.set(0xfbbf24)
        pillarMat.color.set(0xfbbf24)
        topSphere.material.color.set(0xfbbf24)
      }

      if (overlayEl) {
        overlayEl.addEventListener('touchstart', onTouchStart, { passive: false })
        overlayEl.addEventListener('touchmove', onTouchMove, { passive: false })
        overlayEl.addEventListener('touchend', onTouchEnd, { passive: false })
      }

      // === Finalize: confirm button only ===
      const finalizePlacement = async () => {
        if (modelPlaced) return
        modelPlaced = true
        indicatorGroup.visible = false
        setEdgeWarning('')

        // Re-anchor one final time at current position
        await reAnchor(model.position.x, model.position.y, model.position.z)

        setArState('placed')
        console.log('[WebXR] CONFIRMED at:', model.position.toArray().map((v: number) => v.toFixed(2)))
      }

      // Expose finalize for confirm button
      ;(sceneRef as any).finalizePlacement = finalizePlacement

      // === Render Loop ===
      renderer.setAnimationLoop((timestamp: number, frame: any) => {
        if (!frame) { renderer.render(scene, camera); return }
        frameRef = frame

        const threeRefSpace = renderer.xr.getReferenceSpace()

        // --- Process pending anchor update after drag end ---
        if (anchorUpdatePending && !isDragging && threeRefSpace) {
          anchorUpdatePending = false
          reAnchor(model.position.x, model.position.y, model.position.z)
        }

        // --- Update model from placing anchor (keeps model stable) ---
        if (placingAnchor && !isDragging && threeRefSpace) {
          try {
            const anchorPose = frame.getPose(placingAnchor.anchorSpace, threeRefSpace)
            if (anchorPose) {
              model.position.set(
                anchorPose.transform.position.x,
                anchorPose.transform.position.y,
                anchorPose.transform.position.z
              )
              indicatorGroup.position.set(model.position.x, model.position.y, model.position.z)
            }
          } catch (e) { /* anchor unavailable this frame */ }
        }

        // --- Dragging: move model to touch position on floor ---
        if (isDragging && !modelPlaced) {
          ndcVec.set(
            (dragTouchPos.x / w) * 2 - 1,
            -(dragTouchPos.y / h) * 2 + 1
          )
          raycaster.setFromCamera(ndcVec, camera)

          floorPlane.set(new THREE.Vector3(0, 1, 0), -model.position.y)
          if (raycaster.ray.intersectPlane(floorPlane, intersectPoint)) {
            model.position.x += (intersectPoint.x - model.position.x) * 0.25
            model.position.z += (intersectPoint.z - model.position.z) * 0.25
            indicatorGroup.position.x = model.position.x
            indicatorGroup.position.z = model.position.z
          }

          // Hit-test to adjust Y
          try {
            const hits = frame.getHitTestResults(hitTestSource)
            if (hits.length > 0) {
              const pose = hits[0].getPose(threeRefSpace)
              if (pose && Math.abs(pose.transform.position.y - model.position.y) < 0.5) {
                model.position.y += (pose.transform.position.y - model.position.y) * 0.15
                indicatorGroup.position.set(model.position.x, model.position.y, model.position.z)
              }
            }
          } catch (e) { /* skip */ }
        }

        // --- Edge warning ---
        if (!modelPlaced) {
          const screenPos = model.position.clone().project(camera)
          const sx = (screenPos.x + 1) / 2
          const sy = (screenPos.y + 1) / 2
          const margin = 0.15
          let edge = ''
          if (sx < margin) edge = 'left'
          else if (sx > 1 - margin) edge = 'right'
          if (sy < margin) edge = edge ? edge + '-bottom' : 'bottom'
          else if (sy > 1 - margin) edge = edge ? edge + '-top' : 'top'
          setEdgeWarning(edge)
          if (edge) {
            ringMat.color.set(0xef4444)
            discMat.color.set(0xef4444)
            pillarMat.color.set(0xef4444)
            topSphere.material.color.set(0xef4444)
          } else {
            const c = isDragging ? 0x22c55e : 0xfbbf24
            ringMat.color.set(c)
            discMat.color.set(c)
            pillarMat.color.set(c)
            topSphere.material.color.set(c)
          }

          // Pulse animation
          const pulse = 0.6 + Math.sin(timestamp * 0.004) * 0.3
          ringMat.opacity = pulse
          topSphere.material.opacity = pulse
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

        renderer.render(scene, camera)
      })

      session.addEventListener('end', () => {
        renderer.setAnimationLoop(null)
        if (overlayEl) {
          overlayEl.removeEventListener('touchstart', onTouchStart)
          overlayEl.removeEventListener('touchmove', onTouchMove)
          overlayEl.removeEventListener('touchend', onTouchEnd)
        }
        try { hitTestSource?.cancel() } catch (e) {}
        if (placingAnchor) { try { placingAnchor.delete() } catch (e) {} }
      })

      sceneRef.current = {
        finalizePlacement,
        stop: () => {
          if (overlayEl) {
            overlayEl.removeEventListener('touchstart', onTouchStart)
            overlayEl.removeEventListener('touchmove', onTouchMove)
            overlayEl.removeEventListener('touchend', onTouchEnd)
          }
          try { hitTestSource?.cancel() } catch (e) {}
          if (placingAnchor) { try { placingAnchor.delete() } catch (e) {} }
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

  // Build edge warning class
  const edgeClass = edgeWarning ? `edge-warn-${edgeWarning.split('-')[0]}` : ''

  return (
    <div className="ar-page">
      <div id="ar-container" className="ar-container" />
      <div id="ar-overlay" className={`ar-overlay ${arState === 'placing' ? 'ar-overlay-draggable' : ''} ${edgeClass}`}>

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
            <span>拖动模型选择位置 · 点击下方确认放置</span>
          </div>
        )}

        <div className="ar-topbar">
          <div className="ar-back-btn" onClick={goBack}>←</div>
          {arState === 'placing' && (
            <div className="ar-placing-badge">拖动放置中</div>
          )}
          {arState === 'placed' && (
            <div className="ar-locked-badge">已锁定 · 可走近查看</div>
          )}
        </div>

        {arState === 'placing' && (
          <div className="ar-bottom">
            <div className="confirm-place-btn" onClick={() => {
              if (sceneRef.current?.finalizePlacement) {
                sceneRef.current.finalizePlacement()
              }
            }}>
              <span>确认放置</span>
            </div>
          </div>
        )}

        {arState === 'placed' && (
          <div className="ar-bottom">
            <div className="rescan-btn" onClick={rescan}><span>重新放置</span></div>
          </div>
        )}

        {/* Edge warning glow */}
        <div className={`edge-glow edge-left ${edgeWarning.includes('left') ? 'active' : ''}`} />
        <div className={`edge-glow edge-right ${edgeWarning.includes('right') ? 'active' : ''}`} />
        <div className={`edge-glow edge-top ${edgeWarning.includes('top') ? 'active' : ''}`} />
        <div className={`edge-glow edge-bottom ${edgeWarning.includes('bottom') ? 'active' : ''}`} />

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
