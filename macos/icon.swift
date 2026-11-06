import AppKit
import Foundation

guard CommandLine.arguments.count == 3,
      let source = NSImage(contentsOfFile: CommandLine.arguments[2]) else { exit(1) }
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

for (name, pixels) in [("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
                       ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
                       ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
                       ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
                       ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024)] {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: bitmap) else { exit(1) }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    let scale = CGFloat(pixels) / 1024
    let transform = NSAffineTransform()
    transform.scale(by: scale)
    transform.concat()
    NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.14, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 64, y: 64, width: 896, height: 896), xRadius: 205, yRadius: 205).fill()
    NSColor.white.setStroke()
    let monitor = NSBezierPath(roundedRect: NSRect(x: 195, y: 358, width: 486, height: 340), xRadius: 38, yRadius: 38)
    monitor.lineWidth = 32
    monitor.stroke()
    let stand = NSBezierPath()
    stand.lineWidth = 32
    stand.lineCapStyle = .round
    stand.move(to: NSPoint(x: 438, y: 354))
    stand.line(to: NSPoint(x: 438, y: 282))
    stand.move(to: NSPoint(x: 340, y: 282))
    stand.line(to: NSPoint(x: 536, y: 282))
    stand.stroke()
    NSColor(calibratedRed: 0.30, green: 0.83, blue: 0.69, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 610, y: 245, width: 220, height: 405), xRadius: 50, yRadius: 50).fill()
    NSColor(calibratedRed: 0.10, green: 0.12, blue: 0.14, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 632, y: 280, width: 176, height: 326), xRadius: 25, yRadius: 25).fill()
    source.draw(in: NSRect(x: 350, y: 440, width: 176, height: 176))
    source.draw(in: NSRect(x: 653, y: 376, width: 134, height: 134))
    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
    try data.write(to: output.appendingPathComponent(name))
}
