package ink.chyk.edelweiss

import org.springframework.context.annotation.AnnotationConfigApplicationContext

fun main() {
    val context = AnnotationConfigApplicationContext()
    context.scan("ink.chyk.edelweiss")
    context.refresh()
    context.registerShutdownHook()
}
