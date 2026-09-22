plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    // Required once Kotlin is 2.x - the Compose compiler moved into its own plugin.
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    // Reads app/google-services.json and wires the Firebase project into the build.
    id("com.google.gms.google-services") version "4.4.2" apply false
}
