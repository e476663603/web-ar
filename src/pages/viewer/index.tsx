import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import './index.scss'

export default function ViewerPage() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<any>(null)
  const controlsRef = useRef<any>(null)
  const [loading, setLoading] = useState(true)
  const [autoRotate, setAutoRotate] = useState(true)
  const [showHint, setShowHint] = useState(true)

  useEffect(() => {
    let isMounted = true
    let animationId: number

    const initViewer = async () => {
      try {
        if (!canvasRef.current) return

        const THREE = await import('three')
        const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js')

        if (!isMounted) return

        const container = canvasRef.current as HTMLElement
        const width = container.clientWidth
        const height = container.clientHeight

        // Scene
        const scene = new THREE.Scene()

        // Background gradient
        const canvas = document.createElement('canvas')
        canvas.width = 2
        canvas.height = 512
        const ctx = canvas.getContext('2d')!
        const gradient = ctx.createLinearGradient(0, 0, 0, 512)
        gradient.addColorStop(0, '#1a1a2e')
        gradient.addColorStop(0.5, '#0a0a0f')
        gradient.addColorStop(1, '#16213e')
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, 2, 512)
        const bgTexture = new THREE.CanvasTexture(canvas)
        scene.background = bgTexture

        // Camera
        const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 100)
        camera.position.set(0, 0.5, 2.5)

        // Renderer
        const renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
        })
        renderer.setSize(width, height)
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.toneMappingExposure = 1.2
        container.appendChild(renderer.domElement)
        rendererRef.current = renderer

        // Controls - 360° orbit
        const controls = new OrbitControls(camera, renderer.domElement)
        controls.enableDamping = true
        controls.dampingFactor = 0.05
        controls.enableZoom = true
        controls.enablePan = false
        controls.minDistance = 1.2
        controls.maxDistance = 5
        controls.autoRotate = true
        controls.autoRotateSpeed = 2.0
        controls.target.set(0, 0, 0)
        controlsRef.current = controls

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.4)
        scene.add(ambientLight)

        const keyLight = new THREE.DirectionalLight(0xffffff, 1.0)
        keyLight.position.set(2, 3, 2)
        keyLight.castShadow = true
        scene.add(keyLight)

        const fillLight = new THREE.DirectionalLight(0x8b5cf6, 0.4)
        fillLight.position.set(-2, 1, -1)
        scene.add(fillLight)

        const rimLight = new THREE.DirectionalLight(0x6366f1, 0.6)
        rimLight.position.set(0, -1, -2)
        scene.add(rimLight)

        // Create 3D model - elaborate geometric sculpture
        const modelGroup = new THREE.Group()

        // Central dodecahedron
        const dodecaGeometry = new THREE.DodecahedronGeometry(0.5, 0)
        const dodecaMaterial = new THREE.MeshPhysicalMaterial({
          color: 0x6366f1,
          metalness: 0.4,
          roughness: 0.15,
          clearcoat: 1.0,
          clearcoatRoughness: 0.05,
          reflectivity: 1.0,
        })
        const dodecahedron = new THREE.Mesh(dodecaGeometry, dodecaMaterial)
        modelGroup.add(dodecahedron)

        // Inner glowing sphere
        const sphereGeometry = new THREE.SphereGeometry(0.25, 32, 32)
        const sphereMaterial = new THREE.MeshPhysicalMaterial({
          color: 0xa78bfa,
          emissive: 0x7c3aed,
          emissiveIntensity: 0.5,
          metalness: 0.0,
          roughness: 0.3,
          transmission: 0.6,
          thickness: 0.5,
        })
        const innerSphere = new THREE.Mesh(sphereGeometry, sphereMaterial)
        modelGroup.add(innerSphere)

        // Orbiting torus rings
        const torusGeometry = new THREE.TorusGeometry(0.75, 0.02, 16, 100)
        const torusMaterial = new THREE.MeshPhysicalMaterial({
          color: 0x8b5cf6,
          metalness: 0.9,
          roughness: 0.05,
          emissive: 0x4f46e5,
          emissiveIntensity: 0.2,
        })

        const torus1 = new THREE.Mesh(torusGeometry, torusMaterial)
        torus1.rotation.x = Math.PI / 4
        modelGroup.add(torus1)

        const torus2 = new THREE.Mesh(torusGeometry, torusMaterial.clone())
        torus2.rotation.x = -Math.PI / 4
        torus2.rotation.y = Math.PI / 3
        modelGroup.add(torus2)

        const torus3 = new THREE.Mesh(torusGeometry, torusMaterial.clone())
        torus3.rotation.x = Math.PI / 2
        torus3.rotation.z = Math.PI / 6
        modelGroup.add(torus3)

        // Floating octahedrons
        const octaGeometry = new THREE.OctahedronGeometry(0.08, 0)
        const octaMaterial = new THREE.MeshPhysicalMaterial({
          color: 0xc4b5fd,
          metalness: 0.7,
          roughness: 0.1,
          emissive: 0x8b5cf6,
          emissiveIntensity: 0.4,
        })

        const floaters: THREE.Mesh[] = []
        for (let i = 0; i < 8; i++) {
          const oct = new THREE.Mesh(octaGeometry, octaMaterial.clone())
          const angle = (i / 8) * Math.PI * 2
          oct.position.x = Math.cos(angle) * 1.0
          oct.position.y = Math.sin(angle * 2) * 0.3
          oct.position.z = Math.sin(angle) * 1.0
          oct.userData = { angle, speed: 0.3 + Math.random() * 0.4 }
          modelGroup.add(oct)
          floaters.push(oct)
        }

        // Particle field
        const particleCount = 100
        const particlesGeometry = new THREE.BufferGeometry()
        const positions = new Float32Array(particleCount * 3)
        for (let i = 0; i < particleCount; i++) {
          const theta = Math.random() * Math.PI * 2
          const phi = Math.acos(Math.random() * 2 - 1)
          const r = 1.2 + Math.random() * 0.8
          positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
          positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
          positions[i * 3 + 2] = r * Math.cos(phi)
        }
        particlesGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        const particlesMaterial = new THREE.PointsMaterial({
          color: 0xa78bfa,
          size: 0.015,
          transparent: true,
          opacity: 0.6,
          sizeAttenuation: true,
        })
        const particles = new THREE.Points(particlesGeometry, particlesMaterial)
        modelGroup.add(particles)

        // Ground grid
        const gridHelper = new THREE.GridHelper(4, 20, 0x1e1e3f, 0x1e1e3f)
        gridHelper.position.y = -1
        gridHelper.material.opacity = 0.3
        gridHelper.material.transparent = true
        scene.add(gridHelper)

        scene.add(modelGroup)

        if (isMounted) setLoading(false)

        // Hide hint after 3 seconds
        setTimeout(() => {
          if (isMounted) setShowHint(false)
        }, 3500)

        // Animation
        const clock = new THREE.Clock()
        const animate = () => {
          const elapsed = clock.getElapsedTime()

          // Rotate central shape
          dodecahedron.rotation.y = elapsed * 0.3
          dodecahedron.rotation.x = Math.sin(elapsed * 0.2) * 0.1

          // Pulse inner sphere
          const pulse = 1 + Math.sin(elapsed * 2) * 0.1
          innerSphere.scale.set(pulse, pulse, pulse)

          // Rotate rings
          torus1.rotation.z = elapsed * 0.5
          torus2.rotation.z = -elapsed * 0.4
          torus3.rotation.y = elapsed * 0.3

          // Animate floaters
          floaters.forEach((oct) => {
            const { angle, speed } = oct.userData
            const t = elapsed * speed
            oct.position.x = Math.cos(angle + t) * 1.0
            oct.position.z = Math.sin(angle + t) * 1.0
            oct.position.y = Math.sin(t * 2 + angle) * 0.3
            oct.rotation.x = elapsed * speed * 2
            oct.rotation.y = elapsed * speed * 1.5
          })

          // Rotate particles slowly
          particles.rotation.y = elapsed * 0.05

          controls.update()
          renderer.render(scene, camera)
          animationId = requestAnimationFrame(animate)
        }
        animate()

        // Handle resize
        const handleResize = () => {
          const w = container.clientWidth
          const h = container.clientHeight
          camera.aspect = w / h
          camera.updateProjectionMatrix()
          renderer.setSize(w, h)
        }
        window.addEventListener('resize', handleResize)

        return () => {
          window.removeEventListener('resize', handleResize)
        }
      } catch (err) {
        console.error('Viewer init error:', err)
      }
    }

    initViewer()

    return () => {
      isMounted = false
      if (animationId) cancelAnimationFrame(animationId)
      if (rendererRef.current) {
        rendererRef.current.dispose()
      }
    }
  }, [])

  const goBack = () => {
    Taro.navigateBack()
  }

  const toggleAutoRotate = () => {
    if (controlsRef.current) {
      const newValue = !autoRotate
      controlsRef.current.autoRotate = newValue
      setAutoRotate(newValue)
    }
  }

  const resetView = () => {
    if (controlsRef.current) {
      controlsRef.current.reset()
    }
  }

  return (
    <View className="viewer-page">
      <View className="viewer-canvas" ref={canvasRef as any} id="viewer-canvas" />

      {/* Overlay */}
      <View className="viewer-overlay">
        <View className="viewer-back-btn" onClick={goBack}>
          <Text>←</Text>
        </View>
        <Text className="viewer-title">360° 查看</Text>
      </View>

      {/* Hint */}
      {showHint && !loading && (
        <Text className="viewer-hint">拖动旋转 · 双指缩放 · 自由探索</Text>
      )}

      {/* Controls */}
      <View className="viewer-controls">
        <View
          className={`control-btn ${autoRotate ? 'active' : ''}`}
          onClick={toggleAutoRotate}
        >
          <Text>🔄</Text>
        </View>
        <View className="control-btn" onClick={resetView}>
          <Text>🏠</Text>
        </View>
      </View>

      {/* Loading */}
      {loading && (
        <View className="viewer-loading">
          <View className="loading-spinner" />
          <Text className="loading-text">加载3D模型中...</Text>
        </View>
      )}
    </View>
  )
}
