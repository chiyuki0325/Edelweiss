package ink.chyk.edelweiss

import ink.chyk.edelweiss.config.AppConfigLoader
import org.springframework.context.annotation.AnnotationConfigApplicationContext

fun main() {
    val config = AppConfigLoader.load()
    val context = AnnotationConfigApplicationContext()
    context.beanFactory.registerSingleton("appConfig", config)
    context.scan("ink.chyk.edelweiss")
    context.refresh()
    context.registerShutdownHook()
}
