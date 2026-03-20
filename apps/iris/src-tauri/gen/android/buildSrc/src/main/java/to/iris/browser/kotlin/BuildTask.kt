import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        runCargoBuild()
    }

    @Suppress("DEPRECATION")
    fun runCargoBuild() {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val targetTriple = when (target) {
            "aarch64" -> "aarch64-linux-android"
            "armv7" -> "armv7-linux-androideabi"
            "i686" -> "i686-linux-android"
            "x86_64" -> "x86_64-linux-android"
            else -> throw GradleException("Unsupported Android target: $target")
        }
        val abiDir = when (target) {
            "aarch64" -> "arm64-v8a"
            "armv7" -> "armeabi-v7a"
            "i686" -> "x86"
            "x86_64" -> "x86_64"
            else -> throw GradleException("Unsupported Android target: $target")
        }
        val clangBinary = when (target) {
            "aarch64" -> "aarch64-linux-android24-clang"
            "armv7" -> "armv7a-linux-androideabi24-clang"
            "i686" -> "i686-linux-android24-clang"
            "x86_64" -> "x86_64-linux-android24-clang"
            else -> throw GradleException("Unsupported Android target: $target")
        }
        val profile = if (release) "release" else "debug"
        val rootDir = File(project.projectDir, rootDirRel)
        val sdkHome = System.getenv("ANDROID_HOME")
            ?: System.getenv("ANDROID_SDK_ROOT")
            ?: File(System.getProperty("user.home"), "Library/Android/sdk").absolutePath
        val ndkHome = System.getenv("NDK_HOME")
            ?: System.getenv("ANDROID_NDK_HOME")
            ?: File(sdkHome, "ndk")
                .listFiles()
                ?.sortedBy { it.name }
                ?.lastOrNull()
                ?.absolutePath
            ?: throw GradleException("Android NDK not found under $sdkHome/ndk")
        val prebuiltDir = File(ndkHome, "toolchains/llvm/prebuilt")
            .listFiles()
            ?.firstOrNull()
            ?: throw GradleException("Android NDK prebuilt toolchain not found under $ndkHome")
        val toolchainBinDir = File(prebuiltDir, "bin")
        val clangPath = File(toolchainBinDir, clangBinary).absolutePath
        val clangxxPath = "${clangPath}++"
        val arPath = File(toolchainBinDir, "llvm-ar").absolutePath
        val cargoTargetEnvPrefix = targetTriple.uppercase().replace('-', '_')
        val ccTargetEnvSuffix = targetTriple.replace('-', '_')
        val args = mutableListOf(
            "build",
            "--package",
            "iris",
            "--manifest-path",
            "src-tauri/Cargo.toml",
            "--target",
            targetTriple,
            "--features",
            "tauri/custom-protocol tauri/custom-protocol",
            "--lib"
        )
        if (release) {
            args.add("--release")
        }

        project.exec {
            workingDir(rootDir)
            executable("cargo")
            args(args)
            environment("CARGO_TARGET_${cargoTargetEnvPrefix}_LINKER", clangPath)
            environment(
                "CARGO_TARGET_${cargoTargetEnvPrefix}_RUSTFLAGS",
                "-Clink-arg=-landroid -Clink-arg=-llog -Clink-arg=-lOpenSLES"
            )
            environment("CC_${ccTargetEnvSuffix}", clangPath)
            environment("CXX_${ccTargetEnvSuffix}", clangxxPath)
            environment("AR_${ccTargetEnvSuffix}", arPath)
            if (project.logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (project.logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
        }.assertNormalExitValue()

        val builtLibrary = File(rootDir, "src-tauri/target/$targetTriple/$profile/libiris.so")
        if (!builtLibrary.exists()) {
            throw GradleException("Built library not found: ${builtLibrary.absolutePath}")
        }

        val jniLibDir = File(project.projectDir, "src/main/jniLibs/$abiDir").apply {
            mkdirs()
        }
        val linkedLibrary = File(jniLibDir, "libiris.so")
        val linkPath = linkedLibrary.toPath()
        if (Files.exists(linkPath, LinkOption.NOFOLLOW_LINKS) || linkedLibrary.exists()) {
            Files.delete(linkPath)
        }

        try {
            Files.createSymbolicLink(linkPath, builtLibrary.toPath())
        } catch (_: UnsupportedOperationException) {
            Files.copy(builtLibrary.toPath(), linkPath, StandardCopyOption.REPLACE_EXISTING)
        }
    }
}
