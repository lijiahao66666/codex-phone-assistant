#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_BYTES (20 * 1024 * 1024)
#define MAX_PIXELS 16000000ULL
#define MAX_DIMENSION 8192

int main(int argc, char **argv) {
  struct rlimit cpu = {5, 5};
  setrlimit(RLIMIT_CPU, &cpu);
  if (argc != 2) return 2;
  int fd = strcmp(argv[1], "--fd3") == 0 ? dup(3) : open(argv[1], O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) return 1;
  if (lseek(fd, 0, SEEK_SET) < 0) { close(fd); return 1; }
  struct stat st;
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size <= 0 || st.st_size > MAX_BYTES) { close(fd); return 1; }
  size_t length = (size_t)st.st_size, pos = 0;
  UInt8 *bytes = malloc(length);
  if (!bytes) { close(fd); return 1; }
  while (pos < length) { ssize_t n = read(fd, bytes + pos, length - pos); if (n <= 0) { free(bytes); close(fd); return 1; } pos += (size_t)n; }
  struct stat after;
  if (fstat(fd, &after) || after.st_size != st.st_size || after.st_mtimespec.tv_sec != st.st_mtimespec.tv_sec || after.st_mtimespec.tv_nsec != st.st_mtimespec.tv_nsec) { free(bytes); close(fd); return 1; }
  close(fd);
  CFDataRef data = CFDataCreateWithBytesNoCopy(kCFAllocatorDefault, bytes, length, kCFAllocatorNull);
  CGImageSourceRef source = data ? CGImageSourceCreateWithData(data, NULL) : NULL;
  int ok = 0;
  if (source && CGImageSourceGetCount(source) == 1 && CGImageSourceGetStatus(source) == kCGImageStatusComplete && CGImageSourceGetStatusAtIndex(source, 0) == kCGImageStatusComplete) {
    CFStringRef type = CGImageSourceGetType(source);
    const char *mime = type && CFEqual(type, CFSTR("public.png")) ? "image/png" : type && CFEqual(type, CFSTR("public.jpeg")) ? "image/jpeg" : type && CFEqual(type, CFSTR("org.webmproject.webp")) ? "image/webp" : NULL;
    CFDictionaryRef props = CGImageSourceCopyPropertiesAtIndex(source, 0, NULL);
    int width = 0, height = 0;
    if (props) {
      CFNumberRef w = CFDictionaryGetValue(props, kCGImagePropertyPixelWidth), h = CFDictionaryGetValue(props, kCGImagePropertyPixelHeight);
      if (w && h) { CFNumberGetValue(w, kCFNumberIntType, &width); CFNumberGetValue(h, kCFNumberIntType, &height); }
      CFRelease(props);
    }
    if (mime && width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION && (uint64_t)width * height <= MAX_PIXELS) {
      CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
      CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
      size_t row = (size_t)width * 4, total = row * (size_t)height;
      void *pixels = calloc(1, total);
      CGContextRef context = pixels && space ? CGBitmapContextCreate(pixels, width, height, 8, row, space, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big) : NULL;
      if (image && context && CGImageGetWidth(image) == (size_t)width && CGImageGetHeight(image) == (size_t)height) {
        CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
        printf("{\"mime\":\"%s\",\"width\":%d,\"height\":%d}\n", mime, width, height);
        ok = 1;
      }
      if (context) CGContextRelease(context);
      if (space) CGColorSpaceRelease(space);
      if (image) CGImageRelease(image);
      free(pixels);
    }
  }
  if (source) CFRelease(source);
  if (data) CFRelease(data);
  free(bytes);
  return ok ? 0 : 1;
}
