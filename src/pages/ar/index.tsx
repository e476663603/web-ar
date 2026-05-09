import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import './index.scss'

type ARState = 'loading' | 'scanning' | 'detected' | 'placed' | 'error'

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

        const [THREE, mindArModule] = await Promise.all([
          import('three'),
          import('../../lib/mindar/mindar-image-three.prod.js')
        ])
        if (!isMounted) return

        // Load FBXLoader
        const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')

        const MindARThree = mindArModule.MindARThree
        if (!MindARThree) throw new Error('MindAR load failed')

        const mindarThree = new MindARThree({
          container,
          imageTargetSrc: './assets/ar/card.mind',
          uiLoading: 'no', uiScanning: 'no', uiError: 'no',
        })

        const { renderer, scene, camera } = mindarThree
        const anchor = mindarThree.addAnchor(0)

        // Lighting
        scene.add(new THREE.AmbientLight(0xffffff, 0.8))
        const dl = new THREE.DirectionalLight(0xffffff, 1)
        dl.position.set(1, 2, 1); scene.add(dl)

        // Load FBX model onto anchor for PREVIEW during scanning
        let modelGroup: any = null
        const loader = new FBXLoader()
        try {
          const fbx = await new Promise<any>((resolve, reject) => {
            loader.load('./assets/ar/test.fbx', resolve, undefined, reject)
          })
          // Remove all animations
          if (fbx.animations) fbx.animations = []
          // Auto-scale to ~0.5 units
          const box = new THREE.Box3().setFromObject(fbx)
          const size = box.getSize(new THREE.Vector3())
          const maxDim = Math.max(size.x, size.y, size.z)
          const scale = 0.5 / maxDim
          fbx.scale.setScalar(scale)
          // Center model
          const center = box.getCenter(new THREE.Vector3())
          fbx.position.sub(center.multiplyScalar(scale))

          modelGroup = new THREE.Group()
          modelGroup.add(fbx)
        } catch (e) {
          console.warn('FBX load failed, using fallback')
          modelGroup = new THREE.Mesh(
            new THREE.BoxGeometry(0.3, 0.3, 0.3),
            new THREE.MeshStandardMaterial({ color: 0x6366f1 })
          )
        }

        modelGroup.visible = false
        anchor.group.add(modelGroup)

        // Target found = show model preview
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
        const animate = () => {
          renderer.render(scene, camera)
          animId = requestAnimationFrame(animate)
        }
        animate()

        sceneRef.current = {
          THREE, container, FBXLoader,
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

  // Enter WebXR AR
  const placeModel = async () => {
    const ref = sceneRef.current
    if (!ref) return

    if (!navigator.xr) {
      setError('浏览器不支持WebXR，请使用Android Chrome'); setArState('error'); return
    }
    const supported = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false)
    if (!supported) {
      setError('设备不支持AR，请使用Android Chrome + Google Play Services for AR'); setArState('error'); return
    }

    ref.stop()
    const container = ref.container as HTMLElement
    container.innerHTML = ''

    setArState('placed')
    await startWebXR(ref.THREE, ref.FBXLoader, container)
  }

  // ===== ONLY WebXR - True 6DOF =====
  const startWebXR = async (THREE: any, FBXLoaderClass: any, container: HTMLElement) => {
    const w = window.innerWidth, h = window.innerHeight

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.xr.enabled = true
    renderer.domElement.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;'
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(70, w / h, 0.01, 100)

    // Good lighting for FBX model
    scene.add(new THREE.AmbientLight(0xffffff, 1.0))
    const dl = new THREE.DirectionalLight(0xffffff, 1.2)
    dl.position.set(1, 3, 2); scene.add(dl)
    const dl2 = new THREE.DirectionalLight(0xffffff, 0.4)
    dl2.position.set(-2, 1, -1); scene.add(dl2)

    // Load FBX into WebXR scene - NO animation
    let model: any
    try {
      const loader = new FBXLoaderClass()
      const fbx = await new Promise<any>((resolve, reject) => {
        loader.load('./assets/ar/test.fbx', resolve, undefined, reject)
      })
      fbx.animations = []
      const box = new THREE.Box3().setFromObject(fbx)
      const size = box.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z)
      const scale = 0.5 / maxDim
      fbx.scale.setScalar(scale)
      const center = box.getCenter(new THREE.Vector3())
      fbx.position.sub(center.multiplyScalar(scale))
      model = new THREE.Group()
      model.add(fbx)
    } catch (e) {
      model = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.2, 0.2),
        new THREE.MeshStandardMaterial({ color: 0x6366f1 })
      )
    }

    // CRITICAL: Place model at ABSOLUTE world coordinates
    // 'local-floor' reference space = origin at user's feet when session started
    // Model placed 1.5m in front, 0.5m below eye level (roughly on the floor/table)
    model.position.set(0, -0.3, -1.5)
    scene.add(model)

    // Ground shadow
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.25, 32),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.08 })
    )
    shadow.rotation.x = -Math.PI / 2
    shadow.position.copy(model.position)
    shadow.position.y -= 0.01
    scene.add(shadow)

    // Start WebXR session
    const overlayEl = document.getElementById('ar-overlay')
    const sessionInit: any = {
      requiredFeatures: ['local-floor'],
    }
    if (overlayEl) {
      sessionInit.optionalFeatures = ['dom-overlay']
      sessionInit.domOverlay = { root: overlayEl }
    }

    try {
      const session = await navigator.xr!.requestSession('immersive-ar', sessionInit)
      renderer.xr.setReferenceSpaceType('local-floor')
      await renderer.xr.setSession(session)

      // Render loop - model is STATIC, no animation
      // WebXR automatically updates camera position/rotation from ARCore
      // Model stays at fixed world coordinates = does NOT move with phone
      renderer.setAnimationLoop(() => {
        renderer.render(scene, camera)
      })

      session.addEventListener('end', () => {
        renderer.setAnimationLoop(null)
      })

      sceneRef.current = {
        stop: () => { try { session.end() } catch (e) {} renderer.dispose() }
      }
    } catch (err: any) {
      setError('WebXR失败: ' + err.message)
      setArState('error')
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
            <span className="viewfinder-text">对准识别图</span>
          </div>
        )}

        {arState === 'detected' && (
          <div className="ar-detected-overlay">
            <div className="detected-info">模型预览中</div>
            <div className="place-btn" onClick={placeModel}>
              <span>进入AR空间</span>
            </div>
          </div>
        )}

        <div className="ar-topbar">
          <div className="ar-back-btn" onClick={goBack}>←</div>
          {arState === 'placed' && (
            <div className="ar-locked-badge">空间追踪中 · 自由走动环绕</div>
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
