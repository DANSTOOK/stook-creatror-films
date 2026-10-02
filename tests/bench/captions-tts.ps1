# A Spanish recording with a known transcript and known word timings, made
# on this computer with a Windows voice (SAPI), for the subtitles tests.
#
#   powershell -File tests/bench/captions-tts.ps1 -Out <dir> [-Minutes 10]
#
# Writes <dir>/speech.wav (16 kHz mono) and <dir>/speech.json: the text as
# spoken, and for every word the moment the voice started it (SpeakProgress's
# AudioPosition), in milliseconds. The recording is synthetic: a clean voice
# with no noise, music or accent, which is the easy case for any recogniser.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [double]$Minutes = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

# Written for these tests. Plain, varied sentences, with the ¿? and ¡! and
# accents a Spanish transcript has to get right.
$paragraphs = @(
  'Buenos días a todos. Hoy vamos a editar un vídeo corto sobre la ciudad de Guadalajara, desde el mercado hasta la catedral.',
  '¿Alguna vez has intentado grabar con el teléfono mientras caminas? La imagen tiembla mucho, pero se puede corregir durante la edición.',
  'Primero importamos los clips, después los ordenamos en la línea de tiempo y, por último, añadimos la música y los títulos.',
  'El color también importa. Una toma un poco oscura mejora bastante si subimos la exposición y bajamos las sombras con cuidado.',
  '¡Qué bonito quedó el atardecer! Las nubes naranjas y el cielo morado hacen que la escena parezca de una película.',
  'Para los subtítulos conviene escribir frases cortas, de no más de dos líneas, para que el público pueda leerlas sin prisa.',
  'Mi abuela preparaba tamales cada diciembre, y toda la familia se reunía en su cocina a conversar hasta la medianoche.',
  'El tren salió de la estación a las ocho y cuarto, cruzó tres puentes y llegó a la costa justo antes de que empezara a llover.',
  'Los estudiantes presentaron su proyecto de ciencias: un pequeño robot que separa la basura según el material.',
  'Gracias por acompañarnos. En el próximo episodio veremos cómo exportar el vídeo y compartirlo con nuestros amigos.'
)

$text = ($paragraphs -join ' ')
if ($Minutes -gt 0) {
  # Long enough for a speed test: the same paragraphs, again and again.
  $one = $text
  $estimate = 0
  $parts = @()
  while ($estimate -lt $Minutes * 60) {
    $parts += $one
    # About 2.6 words a second at this voice's rate.
    $estimate += (($one -split '\s+').Count) / 2.6
  }
  $text = ($parts -join ' ')
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$wav = Join-Path $Out 'speech.wav'
$json = Join-Path $Out 'speech.json'

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'es-*' -and $_.Enabled } | Select-Object -First 1
if (-not $voice) { throw 'No Spanish SAPI voice is installed.' }
$synth.SelectVoice($voice.VoiceInfo.Name)
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile($wav, $format)

$words = New-Object System.Collections.ArrayList
$handler = Register-ObjectEvent -InputObject $synth -EventName SpeakProgress -Action {
  [void]$Event.MessageData.Add(@{ text = $EventArgs.Text; startMs = [int]$EventArgs.AudioPosition.TotalMilliseconds; char = $EventArgs.CharacterPosition })
} -MessageData $words

$synth.Speak($text)
Start-Sleep -Milliseconds 200
Unregister-Event -SourceIdentifier $handler.Name
$synth.SetOutputToNull()
$synth.Dispose()

$result = @{ voice = $voice.VoiceInfo.Name; culture = $voice.VoiceInfo.Culture.Name; text = $text; words = $words }
$result | ConvertTo-Json -Depth 4 -Compress | Set-Content -Encoding utf8 -Path $json
Write-Output ("{0} words, voice {1}" -f $words.Count, $voice.VoiceInfo.Name)
