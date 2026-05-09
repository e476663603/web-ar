import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import './index.scss'

type ARState = 'loading' | 'preview' | 'scanning' | 'detected' | 'locked' | 'error'

export default function ARPage() {
  const mindarRef = useRef<any>(null)
  const modelGroupRef = useRef<any>(null)
  const animationIdRef = useRef<number>(0)
  const xrSessionRef = useRef<any>(null)
  const [arState, setArState] = useState<ARState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'webxr' | 'mindar' | ''>('')

  useEffect(() => {
    let isMounted = true

    const initAR = async () => {
      try {
        // Pre-request camera
        const preStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        })
        preStream.getTracks().forEach(t => t.stop())

        const container = document.getElementById('ar-container')
        if (!container) throw new Error('Container not found')

        const w = window.innerWidth
        const h = window.innerHeight
        container.style.width = w + 'px'
        container.style.height = h + 'px'

        const [THREE, mindArModule] = await Promise.all([
          import('three'),
          import('../../lib/mindar/mindar-image-three.prod.js')
        ])
        const MindARThree = mindArModule.MindARThree
        if (!MindARThree) throw new Error('MindAR failed to load')
        if (!isMounted) return

        const mindarThree = new MindARThree({
          container: container,
          imageTargetSrc: './assets/ar/card.mind',
          uiLoading: 'no',
          uiScanning: 'no',
          uiError: 'no',
          filterMinCF: 0.0001,
          filterBeta: 0.001,
        })

        mindarRef.current = mindarThree
        const { renderer, scene, camera } = mindarThree

        // Lighting
        scene.add(new THREE.AmbientLight(0xffffff, 0.6))
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
        dirLight.position.set(0.5, 1, 0.8)
        scene.add(dirLight)
        scene.add(new THREE.PointLight(0x8b5cf6, 1, 10))

        // 3D Model on anchor - has natural perspective from MindAR tracking
        const anchor = mindarThree.addAnchor(0)
        const modelGroup = createModel(THREE)
        modelGroupRef.current = modelGroup
        modelGroup.visible = false
        anchor.group.add(modelGroup)

        // Events
        anchor.onTargetFound = () => {
          if (!isMounted) return
          modelGroup.visible = true
          setArState('detected')
        }
        anchor.onTargetLost = () => {
          if (!isMounted) return
          // Keep model visible briefly - don't immediately hide
        }

        // Start MindAR
        await mindarThree.start()

        // Fix video display
        const video = container.querySelector('video')
        if (video) {
          video.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;'
        }

        if (isMounted) {
          setArState('preview')
          const clock = new THREE.Clock()
          const animate = () => {
            const t = clock.getElapsedTime()
            if (modelGroup.visible) animateModel(modelGroup, t)
            renderer.render(scene, camera)
            animationIdRef.current = requestAnimationFrame(animate)
          }
          animate()
        }
      } catch (err: any) {
        console.error('AR Error:', err)
        if (isMounted) { setArState('error'); setError(err.message || 'AR启动失败') }
      }
    }

    initAR()
    return () => {
      isMounted = false
      if (animationIdRef.current) cancelAnimationFrame(animationIdRef.current)
      if (mindarRef.current) { try { mindarRef.current.stop() } catch (e) {} }
      if (xrSessionRef.current) { try { xrSessionRef.current.end() } catch (e) {} }
    }
  }, [])

  // Lock model: try WebXR for real 6DOF, fallback to MindAR continuous tracking
  const lockModel = async () => {
    try {
      // Check if WebXR AR is supported (Android Chrome with ARCore)
      let xrSupported = false
      if (navigator.xr) {
        xrSupported = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false)
      }

      if (xrSupported) {
        // WebXR: true 6DOF, walk around model, near=big far=small
        setArState('locked')
        setMode('webxr')
        await startWebXRSession()
      } else {
        // Fallback: keep MindAR running
        // MindAR naturally tracks the 3D position relative to the card
        // = real perspective (move phone closer to card = model gets bigger)
        // = real angles (move phone around card = see model from different sides)
        setArState('locked')
        setMode('mindar')
        // Model stays on anchor - MindAR provides the perspective naturally
      }
    } catch (err: any) {
      console.error('Lock error:', err)
      // Graceful fallback
      setArState('locked')
      setMode('mindar')
    }
  }

  // WebXR AR Session - full 6DOF positional tracking
  const startWebXRSession = async () => {
    const container = document.getElementById('ar-container')
    if (!container) return

    // Stop MindAR first
    if (mindarRef.current) { mindarRef.current.stop(); mindarRef.current = null }
    if (animationIdRef.current) { cancelAnimationFrame(animationIdRef.current); animationIdRef.current = 0 }
    container.innerHTML = ''

    const THREE = await import('three')
    const w = window.innerWidth
    const h = window.innerHeight

    // Setup Three.js WebXR renderer
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(70, w / h, 0.01, 100)

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.xr.enabled = true
    renderer.domElement.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;'
    container.appendChild(renderer.domElement)

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.8))
    const dl = new THREE.DirectionalLight(0xffffff, 1.0)
    dl.position.set(1, 2, 1)
    scene.add(dl)
    const pl = new THREE.PointLight(0x8b5cf6, 0.8, 10)
    pl.position.set(0, 0, -1)
    scene.add(pl)

    // Model at fixed world position (1.5m in front, slightly below eye level)
    const model = createModel(THREE)
    model.visible = true
    model.position.set(0, -0.2, -1.5)
    model.scale.set(2, 2, 2)
    scene.add(model)

    // Ground indicator (subtle circle so user can see the "floor" anchor point)
    const groundRing = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.52, 64),
      new THREE.MeshBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.25, side: THREE.DoubleSide })
    )
    groundRing.rotation.x = -Math.PI / 2
    groundRing.position.set(0, -0.8, -1.5)
    scene.add(groundRing)

    // Shadow disc
    const shadowDisc = new THREE.Mesh(
      new THREE.CircleGeometry(0.4, 32),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.15 })
    )
    shadowDisc.rotation.x = -Math.PI / 2
    shadowDisc.position.set(0, -0.79, -1.5)
    scene.add(shadowDisc)

    // Request WebXR AR session with dom-overlay for UI
    const overlayEl = document.getElementById('ar-overlay')
    const sessionInit: any = {
      requiredFeatures: ['local-floor'],
    }
    if (overlayEl) {
      sessionInit.optionalFeatures = ['dom-overlay']
      sessionInit.domOverlay = { root: overlayEl }
    }

    const session = await navigator.xr!.requestSession('immersive-ar', sessionInit)
    xrSessionRef.current = session
    renderer.xr.setReferenceSpaceType('local-floor')
    await renderer.xr.setSession(session)

    // XR Animation loop - camera position/rotation automatically tracked by ARCore
    const clock = new THREE.Clock()
    renderer.setAnimationLoop(() => {
      const t = clock.getElapsedTime()
      animateModel(model, t)
      renderer.render(scene, camera)
    })

    session.addEventListener('end', () => {
      renderer.setAnimationLoop(null)
      xrSessionRef.current = null
    })
  }

  const startScan = () => {
    setArState('scanning')
    if (modelGroupRef.current) {
      modelGroupRef.current.visible = false
    }
  }

  const rescan = () => {
    if (xrSessionRef.current) { try { xrSessionRef.current.end() } catch (e) {} xrSessionRef.current = null }
    window.location.reload()
  }

  const goBack = () => {
    if (mindarRef.current) { try { mindarRef.current.stop() } catch (e) {} }
    if (xrSessionRef.current) { try { xrSessionRef.current.end() } catch (e) {} }
    Taro.navigateBack()
  }

  return (
    <div className="ar-page">
      <div id="ar-container" className="ar-container" />
      <div id="ar-overlay" className="ar-overlay">

        {arState === 'loading' && (
          <div className="ar-loading-overlay">
            <div className="ar-loading-spinner" />
            <span className="ar-loading-text">正在启动摄像头...</span>
          </div>
        )}

        {(arState === 'preview' || arState === 'scanning') && (
          <div className="ar-viewfinder">
            <div className="viewfinder-frame">
              <div className="frame-corner top-left" />
              <div className="frame-corner top-right" />
              <div className="frame-corner bottom-left" />
              <div className="frame-corner bottom-right" />
            </div>
            <span className="viewfinder-text">
              {arState === 'preview' ? '将识别图放入框内' : '对准识别图...'}
            </span>
          </div>
        )}

        {arState === 'detected' && (
          <div className="ar-detected-hint">
            <span>模型已出现 · 靠近/远离识别图预览效果</span>
          </div>
        )}

        <div className="ar-topbar">
          <div className="ar-back-btn" onClick={goBack}>←</div>
          {arState === 'locked' && (
            <div className="ar-locked-badge">
              {mode === 'webxr'
                ? '空间追踪中 · 自由走动环绕查看'
                : '保持识别图在画面内 · 靠近/远离/环绕'}
            </div>
          )}
        </div>

        <div className="ar-bottom">
          {arState === 'preview' && (
            <div className="scan-btn" onClick={startScan}>
              <div className="scan-btn-inner"><span>开始扫描</span></div>
            </div>
          )}
          {arState === 'scanning' && (
            <div className="scanning-indicator">
              <div className="scanning-pulse" />
              <span className="scanning-text">扫描中...</span>
            </div>
          )}
          {arState === 'detected' && (
            <div className="lock-btn" onClick={lockModel}><span>固定在此位置</span></div>
          )}
          {arState === 'locked' && (
            <div className="rescan-btn" onClick={rescan}><span>重新扫描</span></div>
          )}
        </div>

        {arState === 'error' && (
          <div className="ar-error">
            <span className="error-icon">!</span>
            <span className="error-text">{error}</span>
            <div className="error-btn" onClick={goBack}>返回首页</div>
          </div>
        )}
      </div>
    </div>
  )
}

function createModel(THREE: any) {
  const group = new THREE.Group()
  // Main icosahedron
  const ico = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.3, 1),
    new THREE.MeshPhysicalMaterial({
      color: 0x6366f1, metalness: 0.3, roughness: 0.2, clearcoat: 1.0
    })
  )
  ico.name = 'ico'
  group.add(ico)

  // Rings
  const ringGeo = new THREE.TorusGeometry(0.45, 0.015, 16, 64)
  const ringMat = new THREE.MeshPhysicalMaterial({
    color: 0x8b5cf6, metalness: 0.8, roughness: 0.1,
    emissive: 0x4f46e5, emissiveIntensity: 0.3
  })
  const r1 = new THREE.Mesh(ringGeo, ringMat)
  r1.rotation.x = Math.PI / 3; r1.name = 'ring1'; group.add(r1)
  const r2 = new THREE.Mesh(ringGeo, ringMat.clone())
  r2.rotation.x = -Math.PI / 3; r2.rotation.y = Math.PI / 4; r2.name = 'ring2'; group.add(r2)
  const r3 = new THREE.Mesh(ringGeo, ringMat.clone())
  r3.rotation.z = Math.PI / 2; r3.name = 'ring3'; group.add(r3)

  // Particles
  const pos = new Float32Array(30 * 3)
  for (let i = 0; i < 30; i++) {
    const t = Math.random() * Math.PI * 2
    const p = Math.random() * Math.PI
    const r = 0.5 + Math.random() * 0.3
    pos[i * 3] = r * Math.sin(p) * Math.cos(t)
    pos[i * 3 + 1] = r * Math.sin(p) * Math.sin(t)
    pos[i * 3 + 2] = r * Math.cos(p)
  }
  const pg = new THREE.BufferGeometry()
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const pts = new THREE.Points(pg, new THREE.PointsMaterial({
    color: 0xa78bfa, size: 0.02, transparent: true, opacity: 0.8
  }))
  pts.name = 'particles'
  group.add(pts)

  return group
}

function animateModel(group: any, t: number) {
  const ico = group.getObjectByName('ico')
  const r1 = group.getObjectByName('ring1')
  const r2 = group.getObjectByName('ring2')
  const r3 = group.getObjectByName('ring3')
  const pts = group.getObjectByName('particles')
  if (ico) {
    ico.rotation.y = t * 0.3
    ico.rotation.x = Math.sin(t * 0.2) * 0.1
    const s = 1 + Math.sin(t * 1.5) * 0.03
    ico.scale.set(s, s, s)
  }
  if (r1) r1.rotation.z = t * 0.5
  if (r2) r2.rotation.z = -t * 0.4
  if (r3) r3.rotation.x = t * 0.3
  if (pts) pts.rotation.y = t * 0.15
}
