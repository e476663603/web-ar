import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import './index.scss'

type ARState = 'loading' | 'scanning' | 'detected' | 'placed' | 'error'

export default function ARPage() {
  const sceneRef = useRef<any>(null)
  const [arState, setArState] = useState<ARState>('loading')
  const [error, setError] = useState('')
  const [mode, setMode] = useState('')

  useEffect(() => {
    let isMounted = true
    let cleanup: (() => void) | null = null

    const init = async () => {
      try {
        const container = document.getElementById('ar-container')
        if (!container) throw new Error('Container not found')
        container.style.width = window.innerWidth + 'px'
        container.style.height = window.innerHeight + 'px'

        const [THREE, mindArModule] = await Promise.all([
          import('three'),
          import('../../lib/mindar/mindar-image-three.prod.js')
        ])
        if (!isMounted) return

        const MindARThree = mindArModule.MindARThree
        if (!MindARThree) throw new Error('MindAR load failed')

        const mindarThree = new MindARThree({
          container,
          imageTargetSrc: './assets/ar/card.mind',
          uiLoading: 'no', uiScanning: 'no', uiError: 'no',
        })

        const { renderer, scene, camera } = mindarThree
        const anchor = mindarThree.addAnchor(0)

        // Lighting for preview
        scene.add(new THREE.AmbientLight(0xffffff, 0.7))
        const dl = new THREE.DirectionalLight(0xffffff, 0.9)
        dl.position.set(0.5, 1, 0.8); scene.add(dl)
        scene.add(new THREE.PointLight(0x8b5cf6, 0.8, 10))

        // Model on anchor = real-time preview during scanning
        const modelGroup = createModel(THREE)
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

        await mindarThree.start()
        if (!isMounted) return

        const video = container.querySelector('video')
        if (video) video.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;'

        setArState('scanning')

        let animId = 0
        const clock = new THREE.Clock()
        const animate = () => {
          const t = clock.getElapsedTime()
          if (modelGroup.visible) animateModel(modelGroup, t)
          renderer.render(scene, camera)
          animId = requestAnimationFrame(animate)
        }
        animate()

        sceneRef.current = {
          THREE, container, mindarThree, animId,
          stop: () => { cancelAnimationFrame(animId); try { mindarThree.stop() } catch (e) {} }
        }
        cleanup = sceneRef.current.stop
      } catch (err: any) {
        if (isMounted) { setArState('error'); setError(err.message) }
      }
    }

    init()
    return () => { isMounted = false; if (cleanup) cleanup() }
  }, [])

  // Place model in fixed space
  const placeModel = async () => {
    const ref = sceneRef.current
    if (!ref) return

    ref.stop()
    const container = ref.container as HTMLElement
    container.innerHTML = ''
    const THREE = ref.THREE

    setArState('placed')

    // Try WebXR (Android Chrome + ARCore)
    let xrOk = false
    if (navigator.xr) {
      xrOk = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false)
    }

    if (xrOk) {
      setMode('webxr')
      await startWebXR(THREE, container)
    } else {
      setMode('gyro')
      await startGyroScene(THREE, container)
    }
  }

  // ===== WebXR: True 6DOF =====
  const startWebXR = async (THREE: any, container: HTMLElement) => {
    const w = window.innerWidth, h = window.innerHeight
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.xr.enabled = true
    renderer.domElement.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;'
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(70, w / h, 0.01, 100)
    addLighting(THREE, scene)

    const model = createModel(THREE)
    model.position.set(0, 0, -1.5)
    model.scale.setScalar(2)
    scene.add(model)
    addGroundIndicator(THREE, scene, model.position)

    const overlayEl = document.getElementById('ar-overlay')
    const sessionInit: any = { requiredFeatures: ['local-floor'] }
    if (overlayEl) { sessionInit.optionalFeatures = ['dom-overlay']; sessionInit.domOverlay = { root: overlayEl } }

    try {
      const session = await navigator.xr!.requestSession('immersive-ar', sessionInit)
      renderer.xr.setReferenceSpaceType('local-floor')
      await renderer.xr.setSession(session)
      const clock = new THREE.Clock()
      renderer.setAnimationLoop(() => { animateModel(model, clock.getElapsedTime()); renderer.render(scene, camera) })
      session.addEventListener('end', () => renderer.setAnimationLoop(null))
      sceneRef.current = { stop: () => { try { session.end() } catch (e) {} } }
    } catch (err) {
      container.innerHTML = ''
      setMode('gyro')
      await startGyroScene(THREE, container)
    }
  }

  // ===== Gyro Scene: ABSOLUTE STABILITY (like Pokemon GO) =====
  // Only rotation tracking. No accelerometer = zero jitter.
  // Model stays at fixed world position. Camera at origin, only rotates.
  const startGyroScene = async (THREE: any, container: HTMLElement) => {
    const w = window.innerWidth, h = window.innerHeight

    // Camera background
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    const video = document.createElement('video')
    video.srcObject = stream
    video.setAttribute('playsinline', 'true')
    video.muted = true
    video.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:1;'
    container.appendChild(video)
    await video.play()

    // Three.js transparent overlay
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 100)
    camera.position.set(0, 0, 0) // FIXED at origin, never moves

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.domElement.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:2;pointer-events:none;'
    container.appendChild(renderer.domElement)

    addLighting(THREE, scene)

    // Model at fixed world position (2m in front of initial camera direction)
    const model = createModel(THREE)
    model.position.set(0, 0, -2)
    model.scale.setScalar(1.8)
    scene.add(model)
    addGroundIndicator(THREE, scene, model.position)

    // === GYROSCOPE ONLY - Triple smoothing for rock-solid stability ===
    let rawAlpha = 0, rawBeta = 90, rawGamma = 0
    let initAlpha: number | null = null
    let hasGyro = false

    // Smoothed values (exponential moving average)
    let sAlpha = 0, sBeta = 90, sGamma = 0
    // Low-pass factor: lower = smoother (0.02-0.05 for stability)
    const SMOOTH = 0.035
    // Dead zone: ignore tiny sensor noise (degrees)
    const DEAD = 0.1
    // Quaternion slerp factor: lower = more stable
    const SLERP = 0.025

    const targetQ = new THREE.Quaternion()
    const currentQ = new THREE.Quaternion()
    let qInitialized = false

    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.alpha !== null) {
        rawAlpha = e.alpha!
        rawBeta = e.beta || 90
        rawGamma = e.gamma || 0
        hasGyro = true
      }
    }

    // Request permission (iOS 13+)
    if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
      try {
        const p = await (DeviceOrientationEvent as any).requestPermission()
        if (p === 'granted') window.addEventListener('deviceorientation', onOrientation, true)
      } catch (e) {}
    } else {
      window.addEventListener('deviceorientation', onOrientation, true)
    }

    const clock = new THREE.Clock()
    let animId = 0

    const animate = () => {
      const t = clock.getElapsedTime()
      animateModel(model, t)

      if (hasGyro) {
        // Capture initial facing direction
        if (initAlpha === null) {
          initAlpha = rawAlpha
          sAlpha = rawAlpha
          sBeta = rawBeta
          sGamma = rawGamma
        }

        // Low-pass filter with dead zone
        const da = angleDiff(sAlpha, rawAlpha)
        const db = rawBeta - sBeta
        const dg = rawGamma - sGamma

        if (Math.abs(da) > DEAD) sAlpha += da * SMOOTH
        if (Math.abs(db) > DEAD) sBeta += db * SMOOTH
        if (Math.abs(dg) > DEAD) sGamma += dg * SMOOTH

        // Normalize sAlpha to 0-360
        while (sAlpha < 0) sAlpha += 360
        while (sAlpha >= 360) sAlpha -= 360

        // Convert to camera rotation (relative to initial direction)
        const yaw = THREE.MathUtils.degToRad(-(sAlpha - initAlpha))
        const pitch = THREE.MathUtils.degToRad(sBeta - 90)
        const roll = THREE.MathUtils.degToRad(-sGamma)

        targetQ.setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'))

        // Slerp for extra smoothness
        if (!qInitialized) {
          currentQ.copy(targetQ)
          qInitialized = true
        } else {
          currentQ.slerp(targetQ, SLERP)
        }
        camera.quaternion.copy(currentQ)
      }

      renderer.render(scene, camera)
      animId = requestAnimationFrame(animate)
    }
    animate()

    sceneRef.current = {
      stop: () => {
        cancelAnimationFrame(animId)
        window.removeEventListener('deviceorientation', onOrientation, true)
        stream.getTracks().forEach(t => t.stop())
        renderer.dispose()
      }
    }
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
            <span className="viewfinder-text">对准识别图 · 模型会出现在图上</span>
          </div>
        )}

        {arState === 'detected' && (
          <div className="ar-detected-overlay">
            <div className="detected-info">预览中 · 确认后点击固定到空间</div>
            <div className="place-btn" onClick={placeModel}>
              <span>固定到空间</span>
            </div>
          </div>
        )}

        <div className="ar-topbar">
          <div className="ar-back-btn" onClick={goBack}>←</div>
          {arState === 'placed' && (
            <div className="ar-locked-badge">
              {mode === 'webxr' ? '空间追踪 · 自由走动' : '已固定 · 转动手机环绕查看'}
            </div>
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

// ===== Utility Functions =====

function angleDiff(current: number, target: number): number {
  let d = target - current
  while (d > 180) d -= 360
  while (d < -180) d += 360
  return d
}

function addLighting(THREE: any, scene: any) {
  scene.add(new THREE.AmbientLight(0xffffff, 0.8))
  const dl = new THREE.DirectionalLight(0xffffff, 1)
  dl.position.set(1, 2, 1); scene.add(dl)
  const pl = new THREE.PointLight(0x8b5cf6, 0.6, 8)
  pl.position.set(0, 0, -1); scene.add(pl)
}

function addGroundIndicator(THREE: any, scene: any, pos: any) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.4, 0.43, 48),
    new THREE.MeshBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.15, side: THREE.DoubleSide })
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.set(pos.x, pos.y - 0.6, pos.z)
  scene.add(ring)
}

function createModel(THREE: any) {
  const group = new THREE.Group()
  const ico = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.3, 1),
    new THREE.MeshPhysicalMaterial({ color: 0x6366f1, metalness: 0.3, roughness: 0.2, clearcoat: 1 })
  )
  ico.name = 'ico'; group.add(ico)

  const ringGeo = new THREE.TorusGeometry(0.45, 0.015, 16, 64)
  const ringMat = new THREE.MeshPhysicalMaterial({ color: 0x8b5cf6, metalness: 0.8, roughness: 0.1, emissive: 0x4f46e5, emissiveIntensity: 0.3 })
  const r1 = new THREE.Mesh(ringGeo, ringMat); r1.rotation.x = Math.PI / 3; r1.name = 'r1'; group.add(r1)
  const r2 = new THREE.Mesh(ringGeo, ringMat.clone()); r2.rotation.x = -Math.PI / 3; r2.rotation.y = Math.PI / 4; r2.name = 'r2'; group.add(r2)
  const r3 = new THREE.Mesh(ringGeo, ringMat.clone()); r3.rotation.z = Math.PI / 2; r3.name = 'r3'; group.add(r3)

  const pts = new Float32Array(30 * 3)
  for (let i = 0; i < 30; i++) {
    const th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI, r = 0.5 + Math.random() * 0.3
    pts[i * 3] = r * Math.sin(ph) * Math.cos(th)
    pts[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th)
    pts[i * 3 + 2] = r * Math.cos(ph)
  }
  const pg = new THREE.BufferGeometry()
  pg.setAttribute('position', new THREE.BufferAttribute(pts, 3))
  const particles = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xa78bfa, size: 0.02, transparent: true, opacity: 0.8 }))
  particles.name = 'pts'; group.add(particles)

  return group
}

function animateModel(group: any, t: number) {
  const ico = group.getObjectByName('ico')
  const r1 = group.getObjectByName('r1')
  const r2 = group.getObjectByName('r2')
  const r3 = group.getObjectByName('r3')
  const pts = group.getObjectByName('pts')
  if (ico) { ico.rotation.y = t * 0.3; ico.scale.setScalar(1 + Math.sin(t * 1.5) * 0.02) }
  if (r1) r1.rotation.z = t * 0.4
  if (r2) r2.rotation.z = -t * 0.3
  if (r3) r3.rotation.x = t * 0.25
  if (pts) pts.rotation.y = t * 0.1
}
