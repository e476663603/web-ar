import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'
import './index.scss'

export default function Index() {
  const goToAR = () => {
    Taro.navigateTo({ url: '/pages/ar/index' })
  }

  const goToViewer = () => {
    Taro.navigateTo({ url: '/pages/viewer/index' })
  }

  const openTargetImage = () => {
    // Open the target image in a new window for the user to print/display
    window.open('https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/examples/image-tracking/assets/card-example/card.png', '_blank')
  }

  return (
    <View className="home-page">
      <View className="home-content">
        <View className="home-icon">
          <View className="icon-inner" />
        </View>
        <Text className="home-title">WebAR</Text>
        <Text className="home-subtitle">
          扫描识别图，展示3D模型{'\n'}支持360°自由环绕查看
        </Text>
        <View className="home-buttons">
          <View className="btn-primary" onClick={goToAR}>
            <Text className="btn-icon">📷</Text>
            <Text>AR 扫描识别</Text>
          </View>
          <View className="btn-secondary" onClick={goToViewer}>
            <Text className="btn-icon">🔄</Text>
            <Text>360° 模型查看</Text>
          </View>
        </View>
        <View className="target-hint">
          <Text className="hint-text">
            使用AR扫描前，请先
            <Text className="hint-link" onClick={openTargetImage}>下载识别图</Text>
            ，打印或在另一设备上展示后对准扫描
          </Text>
        </View>
      </View>
      <View className="home-footer">
        <Text>Powered by MindAR + Three.js</Text>
      </View>
    </View>
  )
}
