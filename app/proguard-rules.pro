# R8 rules for release builds (minify + resource shrinking).
# Library consumer rules (Compose, kotlinx.serialization, Ktor, coroutines) cover most of what is needed;
# add app-specific keeps here if a release build misbehaves while debug works.

# Ktor references JVM-only classes that do not exist on Android.
-dontwarn java.lang.management.**
-dontwarn org.slf4j.**
