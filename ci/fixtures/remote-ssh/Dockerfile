FROM node@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server git ca-certificates && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* && install -d -m 0755 /run/sshd && usermod -p x node
