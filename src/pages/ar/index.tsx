import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import './index.scss'

type ARState = 'preview' | 'scanning' | 'detected' | 'locked' | 'error'

export default function ARPage() {
  const mindarRef = useRef<any>(null)
  const anchorRef = useRef<any>(null)
  const sceneRef = useRef<any>(null)
  const modelGroupRef = useRef<any>(null)
  const rendererRef = useRef<any>(null)
  const cameraRef = useRef<any>(null)
  const animationIdRef = useRef<number>(0)
  const [arState, setArState] = useState<ARState>('preview')
  const [error, setError] = useState<string | null>(null)

  // Initialize camera preview only (no scanning yet)
  useEffect(() => {
    let isMounted = true

    const initCamera = async () => {
      try {
        const container = document.getElementById('ar-container')
        if (!container) throw new Error('Container not found')

        container.style.width = '100vw'
        container.style.height = '100vh'
        container.style.position = 'fixed'
        container.style.top = '0'
        container.style.left = '0'
        container.style.overflow = 'hidden'

        const THREE = await import('three')
        const mindArModule = await import('../../lib/mindar/mindar-image-three.prod.js')
        const MindARThree = mindArModule.MindARThree

        if (!MindARThree || !isMounted) {
          throw new Error('MindAR failed to load')
        }

        // Initialize MindAR but don't start scanning yet
        const mindarThree = new MindARThree({
          container: container,
          imageTargetSrc: './assets/ar/card.mind',
          uiLoading: 'no',
          uiScanning: 'no',
          uiError: 'no',
        })

        mindarRef.current = mindarThree

        const { renderer, scene, camera } = mindarThree
        rendererRef.current = renderer
        sceneRef.current = scene
        cameraRef.current = camera

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
        scene.add(ambientLight)
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8)
        directionalLight.position.set(0.5, 1, 0.8)
        scene.add(directionalLight)
        const pointLight = new THREE.PointLight(0x8b5cf6, 1, 10)
        pointLight.position.set(0, 0.5, 0.5)
        scene.add(pointLight)

        // Create 3D model
        const anchor = mindarThree.addAnchor(0)
        anchorRef.current = anchor

        const modelGroup = new THREE.Group()
        modelGroupRef.current = modelGroup

        // Central icosahedron
        const icoGeometry = new THREE.IcosahedronGeometry(0.3, 1)
        const icoMaterial = new THREE.MeshPhysicalMaterial({
          color: 0x6366f1,
          metalness: 0.3,
          roughness: 0.2,
          clearcoat: 1.0,
          clearcoatRoughness: 0.1,
        })
        const icosahedron = new THREE.Mesh(icoGeometry, icoMaterial)
        modelGroup.add(icosahedron)

        // Orbiting rings
        const ringGeometry = new THREE.TorusGeometry(0.45, 0.015, 16, 64)
        const ringMaterial = new THREE.MeshPhysicalMaterial({
          color: 0x8b5cf6,
          metalness: 0.8,
          roughness: 0.1,
          emissive: 0x4f46e5,
          emissiveIntensity: 0.3,
        })
        const ring1 = new THREE.Mesh(ringGeometry, ringMaterial)
        ring1.rotation.x = Math.PI / 3
        modelGroup.add(ring1)
        const ring2 = new THREE.Mesh(ringGeometry, ringMaterial.clone())
        ring2.rotation.x = -Math.PI / 3
        ring2.rotation.y = Math.PI / 4
        modelGroup.add(ring2)
        const ring3 = new THREE.Mesh(ringGeometry, ringMaterial.clone())
        ring3.rotation.z = Math.PI / 2
        modelGroup.add(ring3)

        // Particles
        const particleCount = 30
        const particlesGeometry = new THREE.BufferGeometry()
        const positions = new Float32Array(particleCount * 3)
        for (let i = 0; i < particleCount; i++) {
          const theta = Math.random() * Math.PI * 2
          const phi = Math.random() * Math.PI
          const r = 0.5 + Math.random() * 0.3
          positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
          positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
          positions[i * 3 + 2] = r * Math.cos(phi)
        }
        particlesGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        const particlesMaterial = new THREE.PointsMaterial({
          color: 0xa78bfa,
          size: 0.02,
          transparent: true,
          opacity: 0.8,
        })
        const particles = new THREE.Points(particlesGeometry, particlesMaterial)
        modelGroup.add(particles)

        // Initially hide model
        modelGroup.visible = false
        anchor.group.add(modelGroup)

        // Target found/lost events
        anchor.onTargetFound = () => {
          if (!isMounted) return
          modelGroup.visible = true
          setArState('detected')
        }
        anchor.onTargetLost = () => {
          if (!isMounted) return
          // Only hide if not locked
          if (modelGroup.userData.locked) return
          modelGroup.visible = false
          setArState('scanning')
        }

        // Start MindAR (camera + rendering, detection is always on but we control UI)
        await mindarThree.start()

        if (isMounted) {
          setArState('preview')
          // Start animation loop
          const clock = new THREE.Clock()
          const animate = () => {
            const elapsed = clock.getElapsedTime()
            if (modelGroup.visible) {
              icosahedron.rotation.y = elapsed * 0.5
              icosahedron.rotation.x = Math.sin(elapsed * 0.3) * 0.2
              ring1.rotation.z = elapsed * 0.8
              ring2.rotation.z = -elapsed * 0.6
              ring3.rotation.x = elapsed * 0.4
              const scale = 1 + Math.sin(elapsed * 2) * 0.05
              icosahedron.scale.set(scale, scale, scale)
              particles.rotation.y = elapsed * 0.2
            }
            renderer.render(scene, camera)
            animationIdRef.current = requestAnimationFrame(animate)
          }
          animate()
        }
      } catch (err: any) {
        console.error('AR init error:', err)
        if (isMounted) {
          setArState('error')
          setError(err.message || '无法启动AR，请确保已授权摄像头权限')
        }
      }
    }

    setTimeout(() => initCamera(), 200)

    return () => {
      isMounted = false
      if (animationIdRef.current) cancelAnimationFrame(animationIdRef.current)
      if (mindarRef.current) mindarRef.current.stop()
    }
  }, [])

  // Start scanning - user presses button
  const startScan = () => {
    setArState('scanning')
    if (modelGroupRef.current) {
      modelGroupRef.current.visible = false
      modelGroupRef.current.userData.locked = false
    }
  }

  // Lock model in place
  const lockModel = () => {
    if (modelGroupRef.current) {
      modelGroupRef.current.userData.locked = true
      setArState('locked')
    }
  }

  // Rescan - reset and scan again
  const rescan = () => {
    if (modelGroupRef.current) {
      modelGroupRef.current.visible = false
      modelGroupRef.current.userData.locked = false
    }
    setArState('scanning')
  }

  const goBack = () => {
    if (mindarRef.current) mindarRef.current.stop()
    Taro.navigateBack()
  }

  return (
    <View className="ar-page">
      <div id="ar-container" className="ar-container" />

      {/* Viewfinder frame - shown during preview and scanning */}
      {(arState === 'preview' || arState === 'scanning') && (
        <View className="ar-viewfinder">
          <View className="viewfinder-frame">
            <View className="frame-corner top-left" />
            <View className="frame-corner top-right" />
            <View className="frame-corner bottom-left" />
            <View className="frame-corner bottom-right" />
          </View>
          <Text className="viewfinder-text">
            {arState === 'preview' ? '将识别图放入框内' : '正在识别中...'}
          </Text>
        </View>
      )}

      {/* Top bar */}
      <View className="ar-topbar">
        <View className="ar-back-btn" onClick={goBack}>
          <Text>←</Text>
        </View>
        {arState === 'locked' && (
          <View className="ar-locked-badge">
            <Text>✓ 已定位</Text>
          </View>
        )}
      </View>

      {/* Bottom controls */}
      <View className="ar-bottom">
        {arState === 'preview' && (
          <View className="scan-btn" onClick={startScan}>
            <View className="scan-btn-inner">
              <Text className="scan-btn-text">开始扫描</Text>
            </View>
          </View>
        )}

        {arState === 'scanning' && (
          <View className="scanning-indicator">
            <View className="scanning-pulse" />
            <Text className="scanning-text">扫描中...</Text>
          </View>
        )}

        {arState === 'detected' && (
          <View className="detected-controls">
            <View className="lock-btn" onClick={lockModel}>
              <Text className="lock-btn-text">✓ 固定位置</Text>
            </View>
          </View>
        )}

        {arState === 'locked' && (
          <View className="locked-controls">
            <View className="rescan-btn" onClick={rescan}>
              <Text className="rescan-btn-text">重新扫描</Text>
            </View>
          </View>
        )}
      </View>

      {/* Error */}
      {arState === 'error' && (
        <View className="ar-error">
          <Text className="error-icon">📷</Text>
          <Text className="error-text">{error}</Text>
          <View className="error-btn" onClick={goBack}>
            <Text>返回首页</Text>
          </View>
        </View>
      )}
    </View>
  )
}
