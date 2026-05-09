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

        const [THREE, mindArModule] = await Promise.all([
          import('three'),
          import('../../lib/mindar/mindar-image-three.prod.js')
        ])
        if (!isMounted) return

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

        // Lighting for preview
        scene.add(new THREE.AmbientLight(0xffffff, 0.8))
        const dl = new THREE.DirectionalLight(0xffffff, 1)
        dl.position.set(1, 2, 1); scene.add(dl)

        // Load FBX model for preview on recognition image
        let modelGroup: any = null
        const loader = new FBXLoader()
        try {
          const fbx = await new Promise<any>((resolve, reject) => {
            loader.load('./assets/ar/test.fbx', resolve, undefined, reject)
          })
          if (fbx.animations) fbx.animations = []
          const box = new THREE.Box3().setFromObject(fbx)
          const size = box.getSize(new THREE.Vector3())
          const maxDim = Math.max(size.x, size.y, size.z)
          const scale = 0.5 / maxDim
          fbx.scale.setScalar(scale)
          const center = box.getCenter(new THREE.Vector3())
          fbx.position.sub(center.multiplyScalar(scale))
          modelGroup = new THREE.Group()
          modelGroup.add(fbx)
        } catch (e) {
          modelGroup = new THREE.Mesh(
            new THREE.BoxGeometry(0.3, 0.3, 0.3),
            new THREE.MeshStandardMaterial({ color: 0x6366f1 })
          )
        }

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

  // Enter WebXR with hit-test for surface anchoring
  const placeModel = async () => {
    const ref = sceneRef.current
    if (!ref) return

    if (!navigator.xr) {
      setError('浏览器不支持WebXR，请使用Android Chrome'); setArState('error'); return
    }
    const supported = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false)
    if (!supported) {
      setError('设备不支持AR，需要Android Chrome + ARCore'); setArState('error'); return
    }

    ref.stop()
    const container = ref.container as HTMLElement
    container.innerHTML = ''

    setArState('placing')
    await startWebXR(ref.THREE, ref.FBXLoader, container)
  }

  // ===== WebXR with hit-test anchoring + shadows =====
  const startWebXR = async (THREE: any, FBXLoaderClass: any, container: HTMLElement) => {
    const w = window.innerWidth, h = window.innerHeight

    // Renderer with shadow support
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.xr.enabled = true
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;'
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(70, w / h, 0.01, 100)

    // === Lighting with shadows (key for depth perception) ===
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
    scene.add(ambientLight)

    // Main directional light that casts shadows
    const sunLight = new THREE.DirectionalLight(0xffffff, 1.5)
    sunLight.position.set(0.5, 3, 1)
    sunLight.castShadow = true
    sunLight.shadow.mapSize.width = 1024
    sunLight.shadow.mapSize.height = 1024
    sunLight.shadow.camera.near = 0.1
    sunLight.shadow.camera.far = 10
    sunLight.shadow.camera.left = -2
    sunLight.shadow.camera.right = 2
    sunLight.shadow.camera.top = 2
    sunLight.shadow.camera.bottom = -2
    sunLight.shadow.bias = -0.001
    scene.add(sunLight)

    // Fill light (no shadow)
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.3)
    fillLight.position.set(-1, 1, -1)
    scene.add(fillLight)

    // === Shadow-receiving ground plane (invisible but catches shadows) ===
    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.ShadowMaterial({ opacity: 0.4 }) // Only shows shadows, otherwise transparent
    )
    shadowPlane.rotation.x = -Math.PI / 2
    shadowPlane.position.y = 0
    shadowPlane.receiveShadow = true
    shadowPlane.visible = false // Hidden until model is placed
    scene.add(shadowPlane)

    // === Load FBX Model ===
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
      const scale = 0.4 / maxDim
      fbx.scale.setScalar(scale)
      // Position so bottom is at y=0 (sits on surface)
      const newBox = new THREE.Box3().setFromObject(fbx)
      fbx.position.y -= newBox.min.y

      // Enable shadow casting on all meshes
      fbx.traverse((child: any) => {
        if (child.isMesh) {
          child.castShadow = true
          child.receiveShadow = true
        }
      })

      model = new THREE.Group()
      model.add(fbx)
    } catch (e) {
      model = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.2, 0.2),
        new THREE.MeshStandardMaterial({ color: 0x6366f1 })
      )
      model.castShadow = true
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

    // === Start WebXR Session with hit-test ===
    const overlayEl = document.getElementById('ar-overlay')
    const sessionInit: any = {
      requiredFeatures: ['hit-test', 'local-floor'],
    }
    if (overlayEl) {
      sessionInit.optionalFeatures = ['dom-overlay', 'depth-sensing']
      sessionInit.domOverlay = { root: overlayEl }
    }

    try {
      const session = await navigator.xr!.requestSession('immersive-ar', sessionInit)
      renderer.xr.setReferenceSpaceType('local-floor')
      await renderer.xr.setSession(session)

      // Get reference space for hit-test
      const refSpace = await session.requestReferenceSpace('local-floor')
      const viewerSpace = await session.requestReferenceSpace('viewer')
      const hitTestSource = await session.requestHitTestSource!({ space: viewerSpace })

      let modelPlaced = false

      // Tap to place
      session.addEventListener('select', () => {
        if (modelPlaced) return
        if (reticle.visible) {
          // Place model at reticle position
          model.position.copy(reticle.position)
          model.visible = true

          // Position shadow plane at same height
          shadowPlane.position.y = reticle.position.y - 0.001
          shadowPlane.position.x = reticle.position.x
          shadowPlane.position.z = reticle.position.z
          shadowPlane.visible = true

          // Update shadow light to target model
          sunLight.target = model
          sunLight.position.set(
            model.position.x + 0.5,
            model.position.y + 3,
            model.position.z + 1
          )

          reticle.visible = false
          modelPlaced = true
          setArState('placed')
        }
      })

      // Render loop with hit-test
      renderer.setAnimationLoop((timestamp: number, frame: any) => {
        if (!modelPlaced && frame) {
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
        hitTestSource?.cancel()
      })

      sceneRef.current = {
        stop: () => {
          try { hitTestSource?.cancel() } catch (e) {}
          try { session.end() } catch (e) {}
          renderer.dispose()
        }
      }
    } catch (err: any) {
      setError('WebXR启动失败: ' + err.message)
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

        {arState === 'placing' && (
          <div className="ar-placing-hint">
            <span>对准平面 · 点击屏幕放置模型</span>
          </div>
        )}

        <div className="ar-topbar">
          <div className="ar-back-btn" onClick={goBack}>←</div>
          {arState === 'placed' && (
            <div className="ar-locked-badge">已放置 · 自由走动环绕查看</div>
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
