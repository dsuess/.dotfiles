FROM nearmapltd/ai_general_gpu:latest

USER root

RUN apt-get update && \
    apt-get install -y zsh
    # && \
   # chmod -R a+w /opt/conda

USER jovyan

ARG CONDA_TOKEN
ENV CONDA_TOKEN=$CONDA_TOKEN

RUN conda config --prepend channels pytorch && \
    conda config --prepend channels "https://conda.anaconda.org/t/${CONDA_TOKEN}/nearmap"
