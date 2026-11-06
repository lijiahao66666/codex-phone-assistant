#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Open each component relative to a held directory, never following symlinks. */
static int descend(int parent, char *path, int final_flags) {
  char *save = NULL;
  char *part = strtok_r(path, "/", &save);
  if (!part) { close(parent); errno = EINVAL; return -1; }
  while (part) {
    char *next = strtok_r(NULL, "/", &save);
    if (!strcmp(part, ".") || !strcmp(part, "..") || !*part) {
      close(parent); errno = EINVAL; return -1;
    }
    int flags = next ? O_RDONLY | O_DIRECTORY : final_flags;
    int fd = openat(parent, part, flags | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    int saved = errno;
    close(parent);
    if (fd < 0) { errno = saved; return -1; }
    parent = fd;
    part = next;
  }
  return parent;
}

static int valid_path(const char *path, int absolute) {
  if (!path || !*path || (path[0] == '/') != absolute || strstr(path, "//")) return 0;
  size_t len = strlen(path);
  return len > (size_t)absolute && path[len - 1] != '/';
}

int main(int argc, char **argv) {
  if ((argc != 4 && argc != 6 && argc != 10) || !valid_path(argv[1], 1) || !valid_path(argv[2], 0)) return 2;
  char *end;
  errno = 0;
  unsigned long long max = strtoull(argv[3], &end, 10);
  if (errno || !*argv[3] || *end || argv[3][0] == '-' || max == 0 || max > 209715200ULL) return 2;
  char *root = strdup(argv[1] + 1), *relative = strdup(argv[2]);
  if (!root || !relative) { free(root); free(relative); return 1; }
  int base = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  int dir = base < 0 ? -1 : descend(base, root, O_RDONLY | O_DIRECTORY);
  int fd = dir < 0 ? -1 : descend(dir, relative, O_RDONLY);
  free(root); free(relative);
  if (fd < 0) return 1;
  struct stat st;
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size < 0 || (uint64_t)st.st_size > max) { close(fd); return 1; }
  if (argc == 10) {
    unsigned long long expected[6];
    for (int i = 0; i < 6; i++) {
      errno = 0;
      expected[i] = strtoull(argv[i + 4], &end, 10);
      if (errno || !*argv[i + 4] || *end || argv[i + 4][0] == '-') { close(fd); return 2; }
    }
#if defined(__APPLE__)
    struct timespec modified = st.st_mtimespec, changed = st.st_ctimespec;
#else
    struct timespec modified = st.st_mtim, changed = st.st_ctim;
#endif
    if ((uint64_t)st.st_dev != expected[0] || (uint64_t)st.st_ino != expected[1] ||
        (uint64_t)st.st_size != expected[2] || (uint64_t)modified.tv_sec != expected[3] ||
        (uint64_t)modified.tv_nsec != expected[4] ||
        ((uint64_t)changed.tv_sec * 1000000000ULL + (uint64_t)changed.tv_nsec) != expected[5]) { close(fd); return 1; }
  }
  uint64_t start = 0, remaining = (uint64_t)st.st_size;
  if (argc == 6) {
    errno = 0;
    unsigned long long offset = strtoull(argv[4], &end, 10);
    if (errno || !*argv[4] || *end || argv[4][0] == '-') { close(fd); return 2; }
    errno = 0;
    unsigned long long length = strtoull(argv[5], &end, 10);
    if (errno || !*argv[5] || *end || argv[5][0] == '-' || length == 0 ||
        offset >= (uint64_t)st.st_size || length > (uint64_t)st.st_size - offset) { close(fd); return 2; }
    start = (uint64_t)offset;
    remaining = (uint64_t)length;
    if (lseek(fd, (off_t)start, SEEK_SET) < 0) { close(fd); return 1; }
  }
  char buf[65536];
  while (remaining) {
    size_t amount = remaining < sizeof(buf) ? (size_t)remaining : sizeof(buf);
    ssize_t n = read(fd, buf, amount);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) { close(fd); return 1; }
    size_t written = 0;
    while (written < (size_t)n) {
      ssize_t w = write(STDOUT_FILENO, buf + written, (size_t)n - written);
      if (w < 0 && errno == EINTR) continue;
      if (w <= 0) { close(fd); return 1; }
      written += (size_t)w;
    }
    remaining -= (uint64_t)n;
  }
  if (argc == 10) {
    struct stat after;
    if (fstat(fd, &after) || after.st_dev != st.st_dev || after.st_ino != st.st_ino || after.st_size != st.st_size) { close(fd); return 1; }
#if defined(__APPLE__)
    if (after.st_mtimespec.tv_sec != st.st_mtimespec.tv_sec || after.st_mtimespec.tv_nsec != st.st_mtimespec.tv_nsec ||
        after.st_ctimespec.tv_sec != st.st_ctimespec.tv_sec || after.st_ctimespec.tv_nsec != st.st_ctimespec.tv_nsec) { close(fd); return 1; }
#else
    if (after.st_mtim.tv_sec != st.st_mtim.tv_sec || after.st_mtim.tv_nsec != st.st_mtim.tv_nsec ||
        after.st_ctim.tv_sec != st.st_ctim.tv_sec || after.st_ctim.tv_nsec != st.st_ctim.tv_nsec) { close(fd); return 1; }
#endif
  }
  close(fd);
  return 0;
}
