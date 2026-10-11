# One Cassandra node for Railway. The same image runs as cassandra-1, cassandra-2 and
# cassandra-3; the variables on each Railway service decide its role (see DEPLOY.md).
FROM cassandra:5.0
COPY railway-entrypoint.sh /usr/local/bin/railway-entrypoint.sh
RUN sed -i "s/\r$//" /usr/local/bin/railway-entrypoint.sh && chmod +x /usr/local/bin/railway-entrypoint.sh
EXPOSE 7000 9042
ENTRYPOINT ["/usr/local/bin/railway-entrypoint.sh"]
CMD ["cassandra", "-f"]
