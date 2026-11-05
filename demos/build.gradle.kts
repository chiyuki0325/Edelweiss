plugins {
    kotlin("jvm")
}

kotlin {
    jvmToolchain(21)
}

repositories {
    mavenCentral()
}

dependencies {
    implementation(project(":"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    implementation("org.springframework:spring-context:7.0.10")
}

fun registerDemo(
    name: String,
    descriptionText: String,
    mainClassName: String,
) {
    tasks.register<JavaExec>(name) {
        group = "demo"
        description = descriptionText

        dependsOn(tasks.named("classes"))
        classpath = sourceSets["main"].runtimeClasspath
        mainClass = mainClassName
    }
}

registerDemo(
    name = "deepSeekMessages",
    descriptionText = "通过 DeepSeek Anthropic Messages API 运行 mock 天气工具 Demo",
    mainClassName = "ink.chyk.edelweiss.demo.DeepSeekMessagesDemoKt",
)

registerDemo(
    name = "deepSeekChatComp",
    descriptionText = "通过 DeepSeek Chat Completions API 运行 mock 天气工具 Demo",
    mainClassName = "ink.chyk.edelweiss.demo.DeepSeekChatCompDemoKt",
)

registerDemo(
    name = "deepSeekResponses",
    descriptionText = "通过 DeepSeek Responses API 运行 mock 天气工具 Demo",
    mainClassName = "ink.chyk.edelweiss.demo.DeepSeekResponsesDemoKt",
)
