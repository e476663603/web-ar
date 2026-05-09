import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import './index.scss'

type ARState = 'loading' | 'preview' | 'scanning' | 'detected' | 'locked' | 'error'

export default function ARPage() {
  const mindarRef = useRef<any>(null)
  const modelGroupRef = useRef<any>(null)
  const animationIdRef = useRef<number>(0)
  const lockedSceneRef = useRef<any>(null)
  const [arState, setArState] = useState<ARState>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    const initAR = async () => {
      try {
        // Pre-request camera permission for faster startup
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

        // 3D Model - attached to anchor, visible immediately on detection
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
          // Keep model visible even when target lost - user can preview position
          // Model stays visible so user can see where it will lock
          setArState(prev => prev === 'detected' ? 'scanning' : prev)
        }

        // Start MindAR
        await mindarThree.start()

        // Fix video
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
      if (mindarRef.current) { try { mindarRef.current.stop() } catch(e) {} }
      if (lockedSceneRef.current) { lockedSceneRef.current.cleanup() }
    }
  }, [])

  // Lock: stop MindAR -> switch to gyro-tracked camera with model fixed in space
  const lockModel = async () => {
    setArState('locked')
    try {
      const container = document.getElementById('ar-container')
      if (mindarRef.current) { mindarRef.current.stop(); mindarRef.current = null }
      if (animationIdRef.current) { cancelAnimationFrame(animationIdRef.current); animationIdRef.current = 0 }
      if (container) container.innerHTML = ''

      const THREE = await import('three')
      await startLockedScene(THREE, container!)
    } catch (err: any) {
      setError(err.message); setArState('error')
    }
  }

  // Gyro-tracked scene with heavy smoothing for stability
  const startLockedScene = async (THREE: any, container: HTMLElement) => {
    const w = window.innerWidth
    const h = window.innerHeight

    // Camera stream - fast startup
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }
    })
    const video = document.createElement('video')
    video.srcObject = stream
    video.setAttribute('playsinline', 'true')
    video.setAttribute('autoplay', 'true')
    video.muted = true
    video.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:1;'
    container.appendChild(video)
    await video.play()

    // Three.js transparent overlay
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 1000)
    camera.position.set(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.domElement.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:2;'
    container.appendChild(renderer.domElement)

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.8))
    const dl = new THREE.DirectionalLight(0xffffff, 1.0)
    dl.position.set(1, 2, 1)
    scene.add(dl)
    const pl = new THREE.PointLight(0x8b5cf6, 0.8, 10)
    pl.position.set(0, 0, -1.5)
    scene.add(pl)

    // Model at fixed world position (in front of user)
    const model = createModel(THREE)
    model.visible = true
    model.position.set(0, 0, -2.5)
    scene.add(model)

    // === Gyroscope with heavy smoothing ===
    // Raw values from sensor
    let rawAlpha = 0, rawBeta = 0, rawGamma = 0
    // Smoothed values (low-pass filtered)
    let smoothAlpha = 0, smoothBeta = 0, smoothGamma = 0
    let initialAlpha: number | null = null
    let hasOrientation = false
    // Smoothing factor: lower = smoother but more lag (0.03-0.08 is stable)
    const SMOOTH_FACTOR = 0.05
    // Target quaternion and current quaternion for slerp
    const targetQuat = new THREE.Quaternion()
    const currentQuat = new THREE.Quaternion()
    // Slerp factor: lower = smoother (0.02-0.08 for stability)
    const SLERP_FACTOR = 0.04

    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.alpha !== null) {
        rawAlpha = e.alpha
        rawBeta = e.beta || 0
        rawGamma = e.gamma || 0
        hasOrientation = true
      }
    }

    // Request permission (iOS 13+)
    if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
      try {
        const perm = await (DeviceOrientationEvent as any).requestPermission()
        if (perm === 'granted') window.addEventListener('deviceorientation', onOrientation, true)
      } catch (e) { console.warn('Gyro permission denied') }
    } else {
      window.addEventListener('deviceorientation', onOrientation, true)
    }

    const clock = new THREE.Clock()
    let animId = 0

    const animate = () => {
      const t = clock.getElapsedTime()

      if (hasOrientation) {
        // Capture initial alpha so model appears in front
        if (initialAlpha === null) initialAlpha = rawAlpha

        // Low-pass filter on raw values
        smoothAlpha += angleDiff(smoothAlpha, rawAlpha) * SMOOTH_FACTOR
        smoothBeta += (rawBeta - smoothBeta) * SMOOTH_FACTOR
        smoothGamma += (rawGamma - smoothGamma) * SMOOTH_FACTOR

        // Convert to radians (relative to initial orientation)
        const alphaRad = THREE.MathUtils.degToRad(smoothAlpha - initialAlpha)
        const betaRad = THREE.MathUtils.degToRad(smoothBeta - 90)
        const gammaRad = THREE.MathUtils.degToRad(-smoothGamma)

        // Set target quaternion from euler
        const euler = new THREE.Euler(betaRad, alphaRad, gammaRad, 'YXZ')
        targetQuat.setFromEuler(euler)

        // Slerp current -> target for ultra-smooth movement
        currentQuat.slerp(targetQuat, SLERP_FACTOR)
        camera.quaternion.copy(currentQuat)
      }

      // Gentle floating animation (very subtle, not rotation)
      const floatY = Math.sin(t * 0.8) * 0.02
      model.position.y = floatY

      renderer.render(scene, camera)
      animId = requestAnimationFrame(animate)
    }
    animate()

    lockedSceneRef.current = {
      cleanup: () => {
        cancelAnimationFrame(animId)
        window.removeEventListener('deviceorientation', onOrientation, true)
        stream.getTracks().forEach(t => t.stop())
        renderer.dispose()
      }
    }
  }

  const startScan = () => {
    setArState('scanning')
    if (modelGroupRef.current) {
      modelGroupRef.current.visible = false
      modelGroupRef.current.userData.locked = false
    }
  }

  const rescan = () => {
    if (lockedSceneRef.current) { lockedSceneRef.current.cleanup(); lockedSceneRef.current = null }
    window.location.reload()
  }

  const goBack = () => {
    if (mindarRef.current) { try { mindarRef.current.stop() } catch(e) {} }
    if (lockedSceneRef.current) { lockedSceneRef.current.cleanup() }
    Taro.navigateBack()
  }

  return (
    <div className="ar-page">
      <div id="ar-container" className="ar-container" />

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
          <span>模型已加载 · 调整位置后点击下方固定</span>
        </div>
      )}

      <div className="ar-topbar">
        <div className="ar-back-btn" onClick={goBack}>←</div>
        {arState === 'locked' && <div className="ar-locked-badge">已固定 · 移动手机环绕查看</div>}
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
  )
}

// Helper: compute shortest angular difference (handles 0/360 wrap)
function angleDiff(current: number, target: number): number {
  let diff = target - current
  while (diff > 180) diff -= 360
  while (diff < -180) diff += 360
  return diff
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
    ico.rotation.y = t * 0.5
    ico.rotation.x = Math.sin(t * 0.3) * 0.2
    const s = 1 + Math.sin(t * 2) * 0.05
    ico.scale.set(s, s, s)
  }
  if (r1) r1.rotation.z = t * 0.8
  if (r2) r2.rotation.z = -t * 0.6
  if (r3) r3.rotation.x = t * 0.4
  if (pts) pts.rotation.y = t * 0.2
}
