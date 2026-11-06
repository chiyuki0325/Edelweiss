package ink.chyk.edelweiss.config

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
class AppConfiguration {
    @Bean
    fun appConfig(): AppConfig = AppConfigLoader.load()
}
