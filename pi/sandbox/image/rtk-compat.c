/*
 * Alpine/musl compatibility for RTK's upstream aarch64 glibc release.
 *
 * gcompat supplies the ELF interpreter and most glibc symbols. RTK 0.44.0
 * additionally imports fcntl64 and __res_init. Both have direct musl
 * equivalents. The extra fcntl argument is harmless for commands that do not
 * consume it and preserves the ABI for commands that do.
 */
extern int fcntl(int fd, int command, ...);
extern int res_init(void);

int fcntl64(int fd, int command, long argument) {
    return fcntl(fd, command, argument);
}

int __res_init(void) {
    return res_init();
}
