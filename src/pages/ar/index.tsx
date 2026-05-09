import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import './index.scss'

export default function ARPage() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mindarRef = useRef<any>(null)
  const [loading, setLoading] = useState(true)
  const [progress, setProgress] = useState(0)
  const [detected, setDetected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true
    let animationId: number

    const initAR = async () => {
      try {
        if (!containerRef.current) return

        setProgress(20)

        // Dynamically import Three.js
        const THREE = await import('three')
        setProgress(40)

        // Import MindAR from local lib (no CDN dependency)
        const mindArModule = await import('../../lib/mindar/mindar-image-three.prod.js')
        const MindARThree = mindArModule.MindARThree
        if (!MindARThree) {
          throw new Error('MindAR library failed to load')
        }
        setProgress(60)

        if (!isMounted) return

        // Initialize MindAR
        const mindarThree = new MindARThree({
          container: containerRef.current,
          imageTargetSrc: './assets/ar/card.mind',
          uiLoading: 'no',
          uiScanning: 'no',
          uiError: 'no',
        })

        mindarRef.current = mindarThree

        const { renderer, scene, camera } = mindarThree

        // Setup lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
        scene.add(ambientLight)

        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8)
        directionalLight.position.set(0.5, 1, 0.8)
        scene.add(directionalLight)

        const pointLight = new THREE.PointLight(0x8b5cf6, 1, 10)
        pointLight.position.set(0, 0.5, 0.5)
        scene.add(pointLight)

        // Create 3D model - animated geometric sculpture
        const anchor = mindarThree.addAnchor(0)

        // Main group
        const modelGroup = new THREE.Group()

        // Central icosahedron
        const icoGeometry = new THREE.IcosahedronGeometry(0.3, 1)
        const icoMaterial = new THREE.MeshPhysicalMaterial({
          color: 0x6366f1,
          metalness: 0.3,
          roughness: 0.2,
          clearcoat: 1.0,
          clearcoatRoughness: 0.1,
          envMapIntensity: 1.0,
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

        // Floating particles
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

        anchor.group.add(modelGroup)

        setProgress(80)

        // Listen for target found/lost
        anchor.onTargetFound = () => {
          if (isMounted) setDetected(true)
        }
        anchor.onTargetLost = () => {
          if (isMounted) setDetected(false)
        }

        // Start AR
        await mindarThree.start()

        setProgress(100)
        if (isMounted) setLoading(false)

        // Animation loop
        const clock = new THREE.Clock()
        const animate = () => {
          const elapsed = clock.getElapsedTime()

          // Rotate model
          icosahedron.rotation.y = elapsed * 0.5
          icosahedron.rotation.x = Math.sin(elapsed * 0.3) * 0.2

          // Rotate rings
          ring1.rotation.z = elapsed * 0.8
          ring2.rotation.z = -elapsed * 0.6
          ring3.rotation.x = elapsed * 0.4

          // Pulse scale
          const scale = 1 + Math.sin(elapsed * 2) * 0.05
          icosahedron.scale.set(scale, scale, scale)

          // Rotate particles
          particles.rotation.y = elapsed * 0.2

          renderer.render(scene, camera)
          animationId = requestAnimationFrame(animate)
        }
        animate()
      } catch (err: any) {
        console.error('AR init error:', err)
        if (isMounted) {
          setLoading(false)
          setError(err.message || '无法启动AR，请确保已授权摄像头权限')
        }
      }
    }

    initAR()

    return () => {
      isMounted = false
      if (animationId) cancelAnimationFrame(animationId)
      if (mindarRef.current) {
        mindarRef.current.stop()
      }
    }
  }, [])

  const goBack = () => {
    if (mindarRef.current) {
      mindarRef.current.stop()
    }
    Taro.navigateBack()
  }

  return (
    <View className="ar-page">
      <View
        className="ar-container"
        ref={containerRef as any}
        id="ar-container"
      />

      {/* Overlay UI */}
      <View className="ar-overlay">
        <View className="ar-back-btn" onClick={goBack}>
          <Text>←</Text>
        </View>
        <View className={`ar-status ${detected ? 'detected' : ''}`}>
          <View className={`status-dot ${detected ? 'active' : ''}`} />
          <Text>{detected ? '已识别' : '扫描中...'}</Text>
        </View>
      </View>

      {/* Scan guide */}
      {!detected && !loading && !error && (
        <View className="ar-scan-guide">
          <Text className="guide-text">将摄像头对准识别图</Text>
        </View>
      )}

      {/* Loading */}
      {loading && (
        <View className="ar-loading">
          <View className="loading-spinner" />
          <Text className="loading-text">正在初始化AR引擎...</Text>
          <View className="loading-progress">
            <View className="progress-bar" style={{ width: `${progress}%` }} />
          </View>
        </View>
      )}

      {/* Error */}
      {error && (
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
