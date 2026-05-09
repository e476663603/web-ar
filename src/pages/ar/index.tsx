import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import './index.scss'

type ARState = 'loading' | 'preview' | 'scanning' | 'detected' | 'locked' | 'error'

export default function ARPage() {
  const mindarRef = useRef<any>(null)
  const modelGroupRef = useRef<any>(null)
  const animationIdRef = useRef<number>(0)
  const [arState, setArState] = useState<ARState>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    const initAR = async () => {
      try {
        // Wait for DOM
        await new Promise(resolve => setTimeout(resolve, 300))

        const container = document.getElementById('ar-container')
        if (!container) throw new Error('Container not found')

        // Force container dimensions using window size (not CSS units)
        const w = window.innerWidth
        const h = window.innerHeight
        container.style.width = w + 'px'
        container.style.height = h + 'px'

        const THREE = await import('three')
        const mindArModule = await import('../../lib/mindar/mindar-image-three.prod.js')
        const MindARThree = mindArModule.MindARThree

        if (!MindARThree) throw new Error('MindAR library failed to load')
        if (!isMounted) return

        const mindarThree = new MindARThree({
          container: container,
          imageTargetSrc: './assets/ar/card.mind',
          uiLoading: 'no',
          uiScanning: 'no',
          uiError: 'no',
        })

        mindarRef.current = mindarThree
        const { renderer, scene, camera } = mindarThree

        // Lighting
        scene.add(new THREE.AmbientLight(0xffffff, 0.6))
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
        dirLight.position.set(0.5, 1, 0.8)
        scene.add(dirLight)
        scene.add(new THREE.PointLight(0x8b5cf6, 1, 10))

        // 3D Model
        const anchor = mindarThree.addAnchor(0)
        const modelGroup = new THREE.Group()
        modelGroupRef.current = modelGroup

        // Icosahedron
        const ico = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.3, 1),
          new THREE.MeshPhysicalMaterial({ color: 0x6366f1, metalness: 0.3, roughness: 0.2, clearcoat: 1.0 })
        )
        modelGroup.add(ico)

        // Rings
        const ringGeo = new THREE.TorusGeometry(0.45, 0.015, 16, 64)
        const ringMat = new THREE.MeshPhysicalMaterial({ color: 0x8b5cf6, metalness: 0.8, roughness: 0.1, emissive: 0x4f46e5, emissiveIntensity: 0.3 })
        const ring1 = new THREE.Mesh(ringGeo, ringMat)
        ring1.rotation.x = Math.PI / 3
        modelGroup.add(ring1)
        const ring2 = new THREE.Mesh(ringGeo, ringMat.clone())
        ring2.rotation.x = -Math.PI / 3
        ring2.rotation.y = Math.PI / 4
        modelGroup.add(ring2)
        const ring3 = new THREE.Mesh(ringGeo, ringMat.clone())
        ring3.rotation.z = Math.PI / 2
        modelGroup.add(ring3)

        // Particles
        const positions = new Float32Array(30 * 3)
        for (let i = 0; i < 30; i++) {
          const theta = Math.random() * Math.PI * 2
          const phi = Math.random() * Math.PI
          const r = 0.5 + Math.random() * 0.3
          positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
          positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
          positions[i * 3 + 2] = r * Math.cos(phi)
        }
        const pGeo = new THREE.BufferGeometry()
        pGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({ color: 0xa78bfa, size: 0.02, transparent: true, opacity: 0.8 }))
        modelGroup.add(particles)

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
          if (modelGroup.userData.locked) return
          modelGroup.visible = false
          setArState(prev => prev === 'detected' ? 'scanning' : prev)
        }

        // Start - this opens camera and begins detection
        await mindarThree.start()

        // After start, ensure video element is visible
        const video = container.querySelector('video')
        if (video) {
          video.style.position = 'absolute'
          video.style.top = '0'
          video.style.left = '0'
          video.style.width = '100%'
          video.style.height = '100%'
          video.style.objectFit = 'cover'
        }

        if (isMounted) {
          setArState('preview')
          const clock = new THREE.Clock()
          const animate = () => {
            const t = clock.getElapsedTime()
            if (modelGroup.visible) {
              ico.rotation.y = t * 0.5
              ico.rotation.x = Math.sin(t * 0.3) * 0.2
              ring1.rotation.z = t * 0.8
              ring2.rotation.z = -t * 0.6
              ring3.rotation.x = t * 0.4
              const s = 1 + Math.sin(t * 2) * 0.05
              ico.scale.set(s, s, s)
              particles.rotation.y = t * 0.2
            }
            renderer.render(scene, camera)
            animationIdRef.current = requestAnimationFrame(animate)
          }
          animate()
        }
      } catch (err: any) {
        console.error('AR Error:', err)
        if (isMounted) {
          setArState('error')
          setError(err.message || '无法启动AR')
        }
      }
    }

    initAR()
    return () => {
      isMounted = false
      if (animationIdRef.current) cancelAnimationFrame(animationIdRef.current)
      if (mindarRef.current) { try { mindarRef.current.stop() } catch(e) {} }
    }
  }, [])

  const startScan = () => {
    setArState('scanning')
    if (modelGroupRef.current) {
      modelGroupRef.current.visible = false
      modelGroupRef.current.userData.locked = false
    }
  }

  const lockModel = () => {
    if (modelGroupRef.current) {
      modelGroupRef.current.userData.locked = true
      setArState('locked')
    }
  }

  const rescan = () => {
    if (modelGroupRef.current) {
      modelGroupRef.current.visible = false
      modelGroupRef.current.userData.locked = false
    }
    setArState('scanning')
  }

  const goBack = () => {
    if (mindarRef.current) { try { mindarRef.current.stop() } catch(e) {} }
    Taro.navigateBack()
  }

  return (
    <div className="ar-page">
      <div id="ar-container" className="ar-container" />

      {/* Loading */}
      {arState === 'loading' && (
        <div className="ar-loading-overlay">
          <div className="ar-loading-spinner" />
          <span className="ar-loading-text">正在启动摄像头...</span>
        </div>
      )}

      {/* Viewfinder */}
      {(arState === 'preview' || arState === 'scanning') && (
        <div className="ar-viewfinder">
          <div className="viewfinder-frame">
            <div className="frame-corner top-left" />
            <div className="frame-corner top-right" />
            <div className="frame-corner bottom-left" />
            <div className="frame-corner bottom-right" />
          </div>
          <span className="viewfinder-text">
            {arState === 'preview' ? '将识别图放入框内' : '正在识别中...'}
          </span>
        </div>
      )}

      {/* Top bar */}
      <div className="ar-topbar">
        <div className="ar-back-btn" onClick={goBack}>←</div>
        {arState === 'locked' && (
          <div className="ar-locked-badge">✓ 已定位</div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="ar-bottom">
        {arState === 'preview' && (
          <div className="scan-btn" onClick={startScan}>
            <div className="scan-btn-inner">
              <span>开始扫描</span>
            </div>
          </div>
        )}
        {arState === 'scanning' && (
          <div className="scanning-indicator">
            <div className="scanning-pulse" />
            <span className="scanning-text">扫描中...</span>
          </div>
        )}
        {arState === 'detected' && (
          <div className="lock-btn" onClick={lockModel}>
            <span>✓ 固定位置</span>
          </div>
        )}
        {arState === 'locked' && (
          <div className="rescan-btn" onClick={rescan}>
            <span>重新扫描</span>
          </div>
        )}
      </div>

      {/* Error */}
      {arState === 'error' && (
        <div className="ar-error">
          <span className="error-icon">⚠️</span>
          <span className="error-text">{error}</span>
          <div className="error-btn" onClick={goBack}>返回首页</div>
        </div>
      )}
    </div>
  )
}
