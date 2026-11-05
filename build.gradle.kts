plugins {
    kotlin("jvm") version "2.3.10"
}

group = "ink.chyk"
version = "1.0-SNAPSHOT"

repositories {
    mavenCentral()
}

kotlin {
    jvmToolchain(21)
}
