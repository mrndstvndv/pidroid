package com.mrndstvndv.pidroid.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val AmoledColorScheme =
  darkColorScheme(
    primary = Purple80,
    secondary = PurpleGrey80,
    tertiary = Pink80,
    background = Color.Black,
    surface = Color.Black,
    surfaceVariant = Color(0xFF0A0A0A),
    surfaceContainerLowest = Color.Black,
    surfaceContainerLow = Color.Black,
    surfaceContainer = Color(0xFF0A0A0A),
    surfaceContainerHigh = Color(0xFF121212),
    surfaceContainerHighest = Color(0xFF1A1A1A),
    onBackground = Color.White,
    onSurface = Color.White,
  )

@Composable
fun PidroidTheme(
  content: @Composable () -> Unit,
) {
  val colorScheme = AmoledColorScheme

  MaterialTheme(colorScheme = colorScheme, typography = Typography, content = content)
}
