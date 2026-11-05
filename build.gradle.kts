plugins {
    kotlin("jvm") version "2.4.10"
    kotlin("plugin.serialization") version "2.4.10"
    kotlin("plugin.spring") version "2.4.10"
    application
}

group = "ink.chyk.edelweiss"
version = "1.0-SNAPSHOT"

repositories {
    mavenCentral()
}

kotlin {
    jvmToolchain(21)
}

application {
    mainClass = "ink.chyk.edelweiss.MainKt"
}

dependencies {
    // 协程核心库
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")

    // JSON 序列化/反序列化
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")

    // 采用 Spring 的 ApplicationContext 管理依赖注入
    implementation("org.springframework:spring-context:7.0.10")
    implementation(kotlin("reflect"))

    // Ktor HTTP 服务器和客户端
    implementation(platform("io.ktor:ktor-bom:3.6.1"))
    implementation("io.ktor:ktor-server-cio")
    implementation("io.ktor:ktor-client-java")
    implementation("io.ktor:ktor-client-content-negotiation")
    implementation("io.ktor:ktor-serialization-kotlinx-json")

    // 日志
    implementation("org.slf4j:slf4j-api:2.0.20")
    runtimeOnly("org.slf4j:slf4j-simple:2.0.20")

    // YAML 配置
    implementation("com.sksamuel.hoplite:hoplite-core:3.0.5")
    implementation("com.sksamuel.hoplite:hoplite-yaml:3.0.5")
    implementation(kotlin("stdlib"))
}
