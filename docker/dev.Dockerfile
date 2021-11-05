FROM nearmapltd/ai_general_gpu:latest

USER root

RUN apt-get update && \
    apt-get install -y zsh && \
    chmod -R a+w /opt/conda

USER jovyan

ARG CONDA_TOKEN
ENV CONDA_TOKEN=$CONDA_TOKEN

RUN conda config --prepend channels pytorch && \
    conda config --prepend channels "https://conda.anaconda.org/t/${CONDA_TOKEN}/nearmap"


RUN mamba create -y --name dev python=3.8 pyaiutils=3.1.1 h5py hdf5plugin numexpr pytorch=1.10 torchvision=0.11 "cudatoolkit>=11.2"

RUN /opt/conda/envs/dev/bin/python -m pip install tensorflow-gpu==2.5

